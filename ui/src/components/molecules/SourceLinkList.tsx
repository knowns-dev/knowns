import { Brain, ExternalLink, FileText, ListTodo, Scale } from "lucide-react";

import { toDocPath } from "../editor/mentionUtils";
import { TASK_TARGET_PATTERN } from "../../lib/knownsReferences";
import { cn } from "../../lib/utils";

export type SourceRef =
	| { kind: "doc"; path: string }
	| { kind: "task"; id: string }
	| { kind: "memory"; id: string }
	| { kind: "decision"; id: string }
	| { kind: "url"; href: string }
	| { kind: "text" };

const TASK_SOURCE_REGEX = new RegExp(`^@task[-/](${TASK_TARGET_PATTERN})$`);

/**
 * Sources are free-form: a Knowns reference, a path inside the repository, or a
 * plain sentence a person typed. Only the first kind can be resolved, so a path
 * like `docs/setup.md` stays text — it names a repository file, which is not
 * necessarily a Knowns doc, and a link that lands nowhere is worse than none.
 */
export function parseSource(raw: string): SourceRef {
	const value = raw.trim();

	if (/^https?:\/\//i.test(value)) return { kind: "url", href: value };

	const doc = value.match(/^@docs?\/(.+)$/);
	if (doc?.[1]) return { kind: "doc", path: toDocPath(value) };

	const task = value.match(TASK_SOURCE_REGEX);
	if (task?.[1]) return { kind: "task", id: task[1] };

	const memory = value.match(/^@memory[-/]([A-Za-z0-9-]+)$/);
	if (memory?.[1]) return { kind: "memory", id: memory[1] };

	const decision = value.match(/^@decision\/(.+)$/);
	if (decision?.[1]) return { kind: "decision", id: decision[1] };

	return { kind: "text" };
}

const ICONS = {
	doc: FileText,
	task: ListTodo,
	memory: Brain,
	decision: Scale,
	url: ExternalLink,
} as const;

interface SourceLinkListProps {
	sources: string[];
	/** Called for every resolvable reference; urls open themselves. */
	onOpen?: (ref: Exclude<SourceRef, { kind: "url" } | { kind: "text" }>, raw: string) => void;
	className?: string;
}

export function SourceLinkList({ sources, onOpen, className }: SourceLinkListProps) {
	if (sources.length === 0) {
		return <p className="text-sm text-muted-foreground">No source linked.</p>;
	}

	return (
		<ul className={cn("divide-y border-y", className)}>
			{sources.map((source) => {
				const ref = parseSource(source);
				const Icon = ref.kind === "text" ? null : ICONS[ref.kind];
				const body = (
					<>
						{Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
						<span className="break-all font-mono text-xs">{source}</span>
					</>
				);

				if (ref.kind === "url") {
					return (
						<li key={source}>
							<a
								href={ref.href}
								target="_blank"
								rel="noreferrer"
								className="flex w-full items-start gap-2 py-3 text-left text-muted-foreground transition-colors hover:text-foreground"
							>
								{body}
							</a>
						</li>
					);
				}

				if (ref.kind === "text" || !onOpen) {
					return (
						<li key={source} className="flex items-start gap-2 break-all py-3 font-mono text-xs text-muted-foreground">
							{source}
						</li>
					);
				}

				return (
					<li key={source}>
						<button
							type="button"
							onClick={() => onOpen(ref, source)}
							className="flex w-full items-start gap-2 py-3 text-left text-muted-foreground transition-colors hover:text-foreground"
						>
							{body}
						</button>
					</li>
				);
			})}
		</ul>
	);
}
