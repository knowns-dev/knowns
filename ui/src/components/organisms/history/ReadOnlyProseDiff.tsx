import { useMemo, useState } from "react";
import { proseParts } from "@/ui/components/ui/knowns/diff/prose-diff-utils";
import { cn } from "@/ui/lib/utils";
import { foldRun } from "./historyDiff";

interface ReadOnlyProseDiffProps {
	before: string;
	after: string;
	className?: string;
}

/**
 * A word diff to read, with no accept or reject: removed words struck through, added words highlighted.
 * Long unchanged stretches fold to their ends so a small edit in a big text stays easy to find.
 */
export function ReadOnlyProseDiff({ before, after, className }: ReadOnlyProseDiffProps) {
	const parts = useMemo(() => proseParts(before, after), [before, after]);
	const [expanded, setExpanded] = useState(false);
	const foldable = parts.some((p) => p.kind === "same" && foldRun(p.text));

	if (before === after) {
		return <p className={cn("px-3 py-3 text-[13px] text-muted-foreground", className)}>No text changes.</p>;
	}

	return (
		<div className={className}>
			<div data-testid="prose-diff" className="whitespace-pre-wrap break-words px-3 py-3 text-[13px] leading-6">
				{parts.map((part, i) => {
					if (part.kind === "edit") {
						return (
							<span key={part.id}>
								{part.old && (
									<del className="rounded-[3px] bg-red-500/12 text-foreground/70 decoration-red-500/50 dark:bg-red-400/12">
										<span className="sr-only">Removed: </span>
										{part.old}
									</del>
								)}
								{part.new && (
									<ins className="rounded-[3px] bg-emerald-500/14 text-foreground no-underline dark:bg-emerald-400/14">
										<span className="sr-only">Added: </span>
										{part.new}
									</ins>
								)}
							</span>
						);
					}
					const fold = expanded ? null : foldRun(part.text);
					if (!fold) return <span key={`s${i}`}>{part.text}</span>;
					return (
						<span key={`s${i}`}>
							{fold.head}
							<span className="text-muted-foreground"> … {fold.hidden.toLocaleString()} unchanged characters … </span>
							{fold.tail}
						</span>
					);
				})}
			</div>
			{foldable && (
				<div className="border-t border-border/50 px-3 py-1.5">
					<button
						type="button"
						className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? "Fold unchanged text" : "Show full text"}
					</button>
				</div>
			)}
		</div>
	);
}
