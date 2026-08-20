import type { GraphEdge, GraphNode } from "@/ui/api/client";
import { ExternalLink, Zap, X } from "lucide-react";
import { cn } from "@/ui/lib/utils";
import type { GraphReferenceItem, SelectedNodeReferences } from "./graph/constants";

interface GraphDetailPanelProps {
	node: GraphNode | null;
	onClose: () => void;
	onNavigate: (node: GraphNode) => void;
	onShowImpact?: (nodeId: string) => void;
	onSelectNode?: (nodeId: string) => void;
	impactActive?: boolean;
	references?: SelectedNodeReferences;
}

const statusBadgeColors: Record<string, string> = {
	todo: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
	"in-progress": "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
	"in-review": "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
	done: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
	blocked: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
	"on-hold": "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
	urgent: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const priorityLabels: Record<string, string> = {
	high: "High",
	medium: "Medium",
	low: "Low",
};

const edgeTypeLabels: Record<GraphEdge["type"], string> = {
	parent: "Parent",
	spec: "Spec",
	mention: "Mention",
	"template-doc": "Template Doc",
	"code-ref": "Code Ref",
	calls: "Calls",
	imports: "Imports",
	contains: "Contains",
	instantiates: "Creates",
	implements: "Implements",
	references: "References",
	"blocked-by": "Blocked By",
	related: "Related",
	depends: "Depends",
	follows: "Follows",
};

const nodeTypeBadgeStyles: Record<GraphNode["type"] | "external", string> = {
	task: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	doc: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
	template: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	memory: "bg-green-500/10 text-green-600 dark:text-green-400",
	decision: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
	code: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	external: "bg-muted text-muted-foreground",
};

const resolutionBadgeStyles: Record<string, string> = {
	resolved_external: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	unresolved: "bg-muted text-muted-foreground",
};

const resolutionBadgeLabels: Record<string, string> = {
	resolved_external: "External",
	unresolved: "Unresolved",
};

function GraphReferenceList({
	title,
	items,
	onSelectNode,
}: {
	title: string;
	items: GraphReferenceItem[];
	onSelectNode?: (nodeId: string) => void;
}) {
	if (items.length === 0) return null;

	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
			<div className="space-y-1">
				{items.map((item, index) => {
					const itemKey = `${title}-${item.edgeType}-${item.nodeId}-${item.label}-${item.resolutionStatus || "none"}-${index}`;
					const isNavigable = !item.isVirtual && item.type !== "external" && !!onSelectNode;
					const content = (
						<div className="flex items-center gap-1.5 min-w-0 flex-wrap">
							<span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide shrink-0", nodeTypeBadgeStyles[item.type])}>
								{item.type}
							</span>
							<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
								{edgeTypeLabels[item.edgeType]}
							</span>
							{item.resolutionStatus && resolutionBadgeLabels[item.resolutionStatus] && (
								<span
									className={cn(
										"rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0",
										resolutionBadgeStyles[item.resolutionStatus] || "bg-muted text-muted-foreground",
									)}
								>
									{resolutionBadgeLabels[item.resolutionStatus]}
								</span>
							)}
							<span className="truncate text-foreground min-w-0 flex-1">{item.label}</span>
						</div>
					);

					if (!isNavigable) {
						return (
							<div
								key={itemKey}
								className="w-full rounded-md border border-border/60 px-2 py-1.5 text-left bg-muted/20"
							>
								{content}
							</div>
						);
					}

					return (
						<button
							key={itemKey}
							type="button"
							onClick={() => onSelectNode?.(item.nodeId)}
							className="w-full rounded-md border border-border/60 px-2 py-1.5 text-left hover:bg-accent transition-colors"
						>
							{content}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function GraphDetailPanel({ node, onClose, onNavigate, onShowImpact, onSelectNode, impactActive, references }: GraphDetailPanelProps) {
	if (!node) return null;

	const [type, ...rest] = node.id.split(":");
	const entityId = rest.join(":");
	const codeKind = typeof node.data.kind === "string" ? node.data.kind : null;
	const codeContent = typeof node.data.content === "string" ? node.data.content.trim() : "";
	const previewLines = codeContent ? codeContent.split("\n") : [];
	const codePreview = previewLines.slice(0, 8).join("\n");
	const hasMoreCode = previewLines.length > 8;
	const incomingRefs = references?.incoming || [];
	const outgoingRefs = references?.outgoing || [];
	const panelWidth = type === "code" ? "w-96" : "w-72";

	return (
		<div className={cn("absolute top-3 right-3 rounded-lg border bg-background/95 backdrop-blur-sm shadow-lg overflow-hidden animate-in slide-in-from-right-2 duration-200 max-h-[calc(100vh-1.5rem)] flex flex-col", panelWidth)}>
			<div className="flex items-start gap-2 p-3 border-b border-border/50 shrink-0">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5 mb-1">
						<span
							className={cn(
								"inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
								type === "task" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
								type === "doc" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
								type === "memory" && "bg-green-500/10 text-green-600 dark:text-green-400",
								type === "code" && "bg-purple-500/10 text-purple-600 dark:text-purple-400",
								type === "template" && "bg-purple-500/10 text-purple-600 dark:text-purple-400",
							)}
						>
							{type}
						</span>
						<span className="text-[10px] text-muted-foreground font-mono truncate">{entityId}</span>
					</div>
					<h3 className="text-sm font-medium leading-snug break-words">{node.label}</h3>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="p-3 space-y-2.5 text-xs overflow-y-auto min-h-0">
				{type === "task" && (
					<>
						<div className="flex items-center gap-2">
							{!!node.data.status && (
								<span
									className={cn(
										"rounded-full px-2 py-0.5 text-[10px] font-medium",
										statusBadgeColors[node.data.status as string] || "bg-muted text-muted-foreground",
									)}
								>
									{node.data.status as string}
								</span>
							)}
							{!!node.data.priority && (
								<span className="text-muted-foreground">
									{priorityLabels[node.data.priority as string] || (node.data.priority as string)} priority
								</span>
							)}
						</div>
						{node.data.assignee && (
							<div className="text-muted-foreground">
								Assignee: <span className="text-foreground">{node.data.assignee as string}</span>
							</div>
						)}
						{Array.isArray(node.data.labels) && (node.data.labels as string[]).length > 0 && (
							<div className="flex flex-wrap gap-1">
								{(node.data.labels as string[]).map((label) => (
									<span
										key={label}
										className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
									>
										{label}
									</span>
								))}
							</div>
						)}
					</>
				)}

				{type === "doc" && (
					<>
						{node.data.description && (
							<p className="text-muted-foreground leading-relaxed">{node.data.description as string}</p>
						)}
						{Array.isArray(node.data.tags) && (node.data.tags as string[]).length > 0 && (
							<div className="flex flex-wrap gap-1">
								{(node.data.tags as string[]).map((tag) => (
									<span
										key={tag}
										className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
									>
										{tag}
									</span>
								))}
							</div>
						)}
					</>
				)}

				{type === "code" && (
					<>
						<div className="flex flex-wrap gap-1.5">
							{codeKind && (
								<span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
									{codeKind}
								</span>
							)}
							{typeof node.data.docPath === "string" && (
								<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground font-mono break-all">
									{node.data.docPath as string}
								</span>
							)}
						</div>
						{codePreview && (
							<div className="space-y-1.5">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</div>
								<pre className="rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-words">
									{codePreview}
									{hasMoreCode ? "\n…" : ""}
								</pre>
							</div>
						)}
						<GraphReferenceList title={`Incoming refs (${incomingRefs.length})`} items={incomingRefs} onSelectNode={onSelectNode} />
						<GraphReferenceList title={`Outgoing refs (${outgoingRefs.length})`} items={outgoingRefs} onSelectNode={onSelectNode} />
						{incomingRefs.length === 0 && outgoingRefs.length === 0 && (
							<div className="text-muted-foreground">No visible refs for this code node with the current graph data.</div>
						)}
					</>
				)}
			</div>

			<div className="px-3 pb-3 flex flex-col gap-1.5 shrink-0">
				{(type === "task" || type === "doc") && (
					<button
						type="button"
						onClick={() => onNavigate(node)}
						className="flex items-center gap-1.5 w-full rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors justify-center"
					>
						<ExternalLink className="w-3 h-3" />
						Preview {type}
					</button>
				)}
				{onShowImpact && (
					<button
						type="button"
						onClick={() => onShowImpact(node.id)}
						className={cn(
							"flex items-center gap-1.5 w-full rounded-md border px-3 py-1.5 text-xs font-medium transition-colors justify-center",
							impactActive
								? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
								: "text-muted-foreground hover:text-foreground hover:bg-accent",
						)}
					>
						<Zap className="w-3 h-3" />
						{impactActive ? "Impact Active" : "Show Impact"}
					</button>
				)}
			</div>
		</div>
	);
}
