import { useEffect, useId, useMemo, useState, type ComponentType } from "react";
import {
	Brain,
	Check,
	ChevronDown,
	FileText,
	GitBranch,
	ListTodo,
	Loader2,
	Plus,
	Search,
} from "lucide-react";
import {
	search as searchKnowns,
	type KnownsSearchResult,
} from "@/ui/api/client";
import type { Task } from "@/ui/models/task";
import { cn } from "@/ui/lib/utils";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/ui/components/ui/popover";

export type ReferenceKind = "doc" | "task" | "decision" | "memory";
export type ReferenceValueMode = "source" | "related-doc" | "related-task";

type ReferenceResult = {
	kind: ReferenceKind;
	id: string;
	title: string;
	detail: string;
	status?: string;
	value: string;
	score: number;
};

type ReferencePickerProps = {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	allowedKinds: ReferenceKind[];
	valueMode: ReferenceValueMode;
	browseLabel?: string;
	className?: string;
};

const kindMeta: Record<
	ReferenceKind,
	{ label: string; Icon: ComponentType<{ className?: string }> }
> = {
	doc: { label: "Doc", Icon: FileText },
	task: { label: "Task", Icon: ListTodo },
	decision: { label: "Decision", Icon: GitBranch },
	memory: { label: "Memory", Icon: Brain },
};

export default function ReferencePicker({
	label,
	value,
	onChange,
	placeholder,
	allowedKinds,
	valueMode,
	browseLabel = "Browse existing",
	className,
}: ReferencePickerProps) {
	const browserId = useId();
	const inputId = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ReferenceResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const allowedKey = allowedKinds.join(",");
	const selectedValues = useMemo(
		() => new Set(splitListInput(value)),
		[value],
	);

	useEffect(() => {
		if (!open) {
			setQuery("");
			setResults([]);
			setError("");
			return;
		}

		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			setResults([]);
			setError("");
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError("");
		const timeoutID = window.setTimeout(() => {
			const allowed = new Set(allowedKey.split(",") as ReferenceKind[]);
			searchKnowns(trimmedQuery)
				.then((searchResult) => {
					if (cancelled) return;
					setResults(
						buildResults({
							allowed,
							valueMode,
							tasks: searchResult.tasks,
							docs: searchResult.docs,
							decisions: searchResult.decisions,
							memories: searchResult.memories,
						}),
					);
				})
				.catch(() => {
					if (cancelled) return;
					setResults([]);
					setError("Search is unavailable. You can still enter a URL or reference manually.");
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 250);

		return () => {
			cancelled = true;
			window.clearTimeout(timeoutID);
		};
	}, [allowedKey, open, query, valueMode]);

	const handleAdd = (result: ReferenceResult) => {
		onChange(appendListValue(value, result.value));
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<div className={cn("grid gap-2", className)}>
				<label className="text-sm font-medium" htmlFor={inputId}>
					{label}
				</label>
				<div className="flex flex-col gap-2 sm:flex-row">
					<input
						id={inputId}
						value={value}
						onChange={(event) => onChange(event.target.value)}
						className="min-h-11 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary sm:min-h-10"
						placeholder={placeholder}
					/>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-expanded={open}
							aria-controls={browserId}
							className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-border/70 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:min-h-10"
						>
							<Search className="h-4 w-4" />
							{browseLabel}
							<ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
						</button>
					</PopoverTrigger>
				</div>
			</div>

			<PopoverContent
				id={browserId}
				align="end"
				side="bottom"
				sideOffset={8}
				collisionPadding={16}
				className="z-[80] w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white p-0 text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.16)] dark:border-border dark:bg-background"
				data-testid="reference-browser"
			>
					<div className="border-b border-border/60 p-3">
						<label className="sr-only" htmlFor={`${browserId}-query`}>
							Search existing references
						</label>
						<div className="relative">
							<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
							<input
								id={`${browserId}-query`}
								autoFocus
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								className="min-h-11 w-full rounded-lg border border-border/60 bg-muted/20 pl-9 pr-10 text-sm outline-none focus:ring-1 focus:ring-primary"
								placeholder="Search by title, path, or ID…"
							/>
							{loading ? (
								<Loader2
									className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
									aria-label="Searching"
								/>
							) : null}
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Choose an existing Knowns item, or keep using the field above for external URLs and special refs.
						</p>
					</div>

					<div className="max-h-72 overflow-y-auto" aria-live="polite">
						{error ? (
							<p className="rounded-lg bg-destructive/10 px-3 py-3 text-sm text-destructive" role="alert">
								{error}
							</p>
						) : !query.trim() ? (
							<p className="px-3 py-5 text-center text-sm text-muted-foreground">
								Type a name, path, or ID to find an existing source.
							</p>
						) : !loading && results.length === 0 ? (
							<p className="px-3 py-5 text-center text-sm text-muted-foreground">
								No matching references found.
							</p>
						) : (
							<ul className="divide-y divide-border/60">
								{results.map((result) => {
									const { Icon, label } = kindMeta[result.kind];
									const selected = selectedValues.has(result.value);
									return (
										<li key={`${result.kind}-${result.id}`}>
											<button
												type="button"
												onClick={() => handleAdd(result)}
												disabled={selected}
												className="group flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:bg-muted/50"
												aria-label={`${selected ? "Added" : "Add"} ${label}: ${result.title}`}
											>
												<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/60">
													<Icon className="h-4 w-4 text-muted-foreground" />
												</span>
												<span className="min-w-0 flex-1">
													<span className="flex flex-wrap items-center gap-2">
														<span className="truncate text-sm font-medium">{result.title}</span>
														<span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
															{label}
														</span>
														{result.status ? (
															<span className="text-xs text-muted-foreground">{result.status}</span>
														) : null}
													</span>
													<span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
														{result.detail}
													</span>
												</span>
												<span className="inline-flex min-w-14 shrink-0 items-center justify-end gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
													{selected ? (
														<>
															<Check className="h-4 w-4" />
															Added
														</>
													) : (
														<>
															<Plus className="h-4 w-4" />
															Add
														</>
													)}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
			</PopoverContent>
		</Popover>
	);
}

function buildResults({
	allowed,
	valueMode,
	tasks,
	docs,
	decisions,
	memories,
}: {
	allowed: Set<ReferenceKind>;
	valueMode: ReferenceValueMode;
	tasks: Task[];
	docs: KnownsSearchResult[];
	decisions: KnownsSearchResult[];
	memories: KnownsSearchResult[];
}) {
	const results: ReferenceResult[] = [];

	if (allowed.has("doc")) {
		for (const doc of docs.slice(0, 8)) {
			const path = normalizeDocPath(doc.path || doc.id);
			if (!path) continue;
			results.push({
				kind: "doc",
				id: path,
				title: doc.title || path,
				detail: `@doc/${path}`,
				value: valueMode === "source" ? `@doc/${path}` : path,
				score: doc.score,
			});
		}
	}

	if (allowed.has("task")) {
		for (const task of tasks.slice(0, 8)) {
			if (!task.id || !task.title) continue;
			results.push({
				kind: "task",
				id: task.id,
				title: task.title,
				detail: `@task/${task.id}`,
				status: task.status,
				value: valueMode === "source" ? `@task/${task.id}` : task.id,
				score: task.score ?? 0,
			});
		}
	}

	if (allowed.has("decision")) {
		for (const decision of decisions.slice(0, 8)) {
			if (!decision.id || !decision.title) continue;
			results.push({
				kind: "decision",
				id: decision.id,
				title: decision.title,
				detail: `@decision/${decision.id}`,
				status: decision.status,
				value: `@decision/${decision.id}`,
				score: decision.score,
			});
		}
	}

	if (allowed.has("memory")) {
		for (const memory of memories.slice(0, 8)) {
			if (!memory.id || !memory.title) continue;
			results.push({
				kind: "memory",
				id: memory.id,
				title: memory.title,
				detail: `@memory/${memory.id}`,
				status: [memory.memoryLayer, memory.status].filter(Boolean).join(" · "),
				value: `@memory/${memory.id}`,
				score: memory.score,
			});
		}
	}

	return results.sort((left, right) => right.score - left.score).slice(0, 20);
}

function normalizeDocPath(path: string) {
	return path
		.trim()
		.replace(/^@doc\//, "")
		.replace(/^\.knowns\/docs\//, "")
		.replace(/\.md$/, "");
}

function splitListInput(value: string) {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function appendListValue(current: string, next: string) {
	const values = splitListInput(current);
	if (!values.includes(next)) values.push(next);
	return values.join(", ");
}
