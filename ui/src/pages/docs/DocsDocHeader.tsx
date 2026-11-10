import type { ElementType } from "react";
import { ChevronDown, ListChecks, Link2, AtSign, History } from "lucide-react";
import {
	CopyPageButton,
	DocsPageHeader,
	type DocsPageLink,
} from "@/ui/components/ui/knowns/blocks/docs/docs-page-header";
import type { BreadcrumbItem } from "@/ui/components/ui/knowns/breadcrumb";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Progress } from "@/ui/components/ui/knowns/progress";
import { toast } from "../../components/ui/sonner";
import { cn, getSpecStatus, isSpec, parseACProgress } from "../../lib/utils";

interface DocData {
	path: string;
	content: string;
	isImported?: boolean;
	metadata: {
		title?: string;
		description?: string;
		tags?: string[];
		updatedAt: string;
		status?: string;
		type?: string;
	};
}

interface LinkedTask {
	id: string;
	title: string;
	status: string;
	archived?: boolean;
}

type MetaField = "title" | "description" | "tags";

interface DocsDocHeaderProps {
	selectedDoc: DocData;
	/** `@doc/specs/password-reset`, what Copy reference puts on the clipboard. */
	reference: string;
	breadcrumb: BreadcrumbItem[];
	prev?: DocsPageLink | null;
	next?: DocsPageLink | null;
	pagerLinkAs?: ElementType;
	onOpenHistory: () => void;
	metaTitle: string;
	setMetaTitle: (v: string) => void;
	metaDescription: string;
	setMetaDescription: (v: string) => void;
	metaTags: string;
	setMetaTags: (v: string) => void;
	handleSaveMetadata: (field: MetaField) => void;
	/** The last failed metadata save, shown under its field. */
	metaError?: { field: MetaField; message: string } | null;
	linkedTasks: LinkedTask[];
	linkedTasksExpanded: boolean;
	setLinkedTasksExpanded: (v: boolean) => void;
	openTask: (id: string) => void;
}

const SPEC_STATUS_TONE: Record<string, BadgeTone> = { approved: "success", implemented: "info", draft: "warning" };
const TASK_DOT: Record<string, string> = {
	done: "bg-emerald-500",
	"in-progress": "bg-amber-500",
	"in-review": "bg-violet-500",
	blocked: "bg-red-500",
};

function formatUpdated(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function DocsDocHeader({
	selectedDoc,
	reference,
	breadcrumb,
	prev,
	next,
	pagerLinkAs,
	onOpenHistory,
	metaTitle,
	setMetaTitle,
	metaDescription,
	setMetaDescription,
	metaTags,
	setMetaTags,
	handleSaveMetadata,
	metaError,
	linkedTasks,
	linkedTasksExpanded,
	setLinkedTasksExpanded,
	openTask,
}: DocsDocHeaderProps) {
	const readOnly = Boolean(selectedDoc.isImported);
	const spec = isSpec(selectedDoc as Parameters<typeof isSpec>[0]);
	const specStatus = spec ? getSpecStatus(selectedDoc as Parameters<typeof getSpecStatus>[0]) : undefined;
	const acProgress = spec ? parseACProgress(selectedDoc.content) : { total: 0, completed: 0 };
	const archivedCount = linkedTasks.filter((task) => task.archived).length;
	const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") event.currentTarget.blur();
	};

	const copy = (text: string, message: string) => {
		void navigator.clipboard.writeText(text).then(() => toast.success(message));
	};

	return (
		<div className="mb-10">
			<DocsPageHeader
				breadcrumb={breadcrumb}
				title={
					readOnly ? (
						selectedDoc.metadata.title
					) : (
						<input
							type="text"
							value={metaTitle}
							onChange={(event) => setMetaTitle(event.target.value)}
							onBlur={() => handleSaveMetadata("title")}
							onKeyDown={blurOnEnter}
							aria-label="Doc title"
							aria-invalid={metaError?.field === "title" || undefined}
							placeholder="Untitled"
							className="min-w-[6ch] max-w-full rounded-md bg-transparent p-0 outline-none [field-sizing:content] placeholder:text-muted-foreground/40 focus-visible:bg-muted/40"
						/>
					)
				}
				badge={
					(spec || readOnly) && (
						<span className="flex items-center gap-1.5" data-toc="false">
							{spec && <Badge tone="info" size="sm">Spec</Badge>}
							{specStatus && (
								<Badge tone={SPEC_STATUS_TONE[specStatus] ?? "neutral"} size="sm" dot>
									{specStatus.charAt(0).toUpperCase() + specStatus.slice(1)}
								</Badge>
							)}
							{readOnly && <Badge tone="neutral" variant="outline" size="sm">Imported</Badge>}
						</span>
					)
				}
				lead={
					readOnly ? (
						selectedDoc.metadata.description || undefined
					) : (
						<input
							type="text"
							value={metaDescription}
							onChange={(event) => setMetaDescription(event.target.value)}
							onBlur={() => handleSaveMetadata("description")}
							onKeyDown={blurOnEnter}
							aria-label="Doc description"
							aria-invalid={metaError?.field === "description" || undefined}
							placeholder="Add a description..."
							className="w-full rounded-md bg-transparent p-0 text-inherit outline-none placeholder:text-muted-foreground/45 focus-visible:bg-muted/40"
						/>
					)
				}
				actions={
					<CopyPageButton
						getText={() => selectedDoc.content || ""}
						label="Copy page"
						onCopied={() => toast.success("Copied the doc as Markdown")}
						items={[
							{ id: "reference", label: "Copy reference", description: reference, icon: <AtSign /> },
							{ id: "link", label: "Copy link", icon: <Link2 /> },
							{ id: "history", label: "Version history", icon: <History /> },
						]}
						onSelect={(item) => {
							if (item.id === "reference") copy(reference, `Copied ${reference}`);
							else if (item.id === "link") copy(window.location.href.split("#")[0] ?? window.location.href, "Copied the link");
							else if (item.id === "history") onOpenHistory();
						}}
					/>
				}
				prev={prev}
				next={next}
				linkAs={pagerLinkAs}
			/>
			<FieldError error={metaError} field="title" />
			<FieldError error={metaError} field="description" />

			<div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted-foreground">
				{readOnly ? (
					(selectedDoc.metadata.tags?.length ?? 0) > 0 && (
						<span className="flex flex-wrap items-center gap-1.5">
							{selectedDoc.metadata.tags!.map((tag) => (
								<Badge key={tag} variant="outline" size="sm">{tag}</Badge>
							))}
						</span>
					)
				) : (
					<label className="flex min-w-[12rem] flex-1 items-center gap-2">
						<span className="shrink-0">Tags</span>
						<input
							type="text"
							value={metaTags}
							onChange={(event) => setMetaTags(event.target.value)}
							onBlur={() => handleSaveMetadata("tags")}
							onKeyDown={blurOnEnter}
							aria-invalid={metaError?.field === "tags" || undefined}
							placeholder="Add tags..."
							className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/45 hover:bg-muted/40 focus-visible:bg-muted/50"
						/>
					</label>
				)}
				<span className="tabular-nums">Updated {formatUpdated(selectedDoc.metadata.updatedAt)}</span>
			</div>
			<FieldError error={metaError} field="tags" />

			{spec && (
				<section aria-label="Spec progress" className="mt-5 overflow-hidden rounded-xl border bg-card">
					{acProgress.total > 0 && (
						<div className="flex items-center gap-3 px-4 py-3">
							<ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="shrink-0 text-[13px] font-medium">Acceptance criteria</span>
							<Progress
								value={acProgress.completed}
								max={acProgress.total}
								tone={acProgress.completed === acProgress.total ? "success" : "accent"}
								size="sm"
								format={(value) => `${value}/${acProgress.total}`}
								aria-label="Acceptance criteria done"
								className="min-w-24 flex-1"
							/>
						</div>
					)}
					<div className={cn(acProgress.total > 0 && "border-t")}>
						<button
							type="button"
							onClick={() => setLinkedTasksExpanded(!linkedTasksExpanded)}
							aria-expanded={linkedTasksExpanded}
							className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
						>
							<span className="font-medium text-foreground">
								{linkedTasks.length} linked {linkedTasks.length === 1 ? "task" : "tasks"}
							</span>
							{archivedCount > 0 && <span>{archivedCount} archived</span>}
							<ChevronDown className={cn("ml-auto size-3.5 transition-transform", linkedTasksExpanded && "rotate-180")} aria-hidden="true" />
						</button>
						{linkedTasksExpanded && (
							<div className="border-t px-2 py-1.5">
								{linkedTasks.length === 0 ? (
									<p className="px-2 py-1.5 text-[13px] text-muted-foreground">No tasks are linked to this spec yet.</p>
								) : (
									linkedTasks.map((task) => (
										<button
											type="button"
											key={task.id}
											onClick={() => openTask(task.id)}
											className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className={cn("size-1.5 shrink-0 rounded-full", TASK_DOT[task.status] ?? "bg-muted-foreground/50")} aria-hidden="true" />
											<span className="min-w-0 flex-1 truncate">{task.title}</span>
											<span className="shrink-0 text-[12px] text-muted-foreground">{task.status}</span>
											{task.archived && <Badge variant="outline" size="sm">archived</Badge>}
										</button>
									))
								)}
							</div>
						)}
					</div>
				</section>
			)}
		</div>
	);
}

function FieldError({ error, field }: { error?: { field: MetaField; message: string } | null; field: MetaField }) {
	if (!error || error.field !== field) return null;
	return (
		<p role="alert" className="mt-2 max-w-2xl text-xs leading-5 text-destructive">
			{error.message}
		</p>
	);
}
