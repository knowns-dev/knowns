import { useState } from "react";
import type { AuditToolStats } from "@/ui/api/client";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Ban, ChevronDown, ChevronUp, CircleAlert } from "lucide-react";

function getOutcomeCount(
	tool: AuditToolStats,
	result: "success" | "error" | "denied",
): number {
	return tool.byResult[result] ?? 0;
}

export function TopTools({
	tools,
	onSelectTool,
}: {
	tools: AuditToolStats[];
	onSelectTool: (tool: string) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const rankedTools = [...tools].sort(
		(left, right) =>
			right.totalCalls - left.totalCalls || left.tool.localeCompare(right.tool),
	);
	const visibleTools = showAll ? rankedTools : rankedTools.slice(0, 10);
	const maxCalls = rankedTools[0]?.totalCalls || 1;

	return (
		<section
			aria-labelledby="audit-tools-heading"
			className="min-w-0 rounded-xl border bg-card p-5 sm:p-6"
		>
			<h2 id="audit-tools-heading" className="text-sm font-semibold">
				Top Tools
			</h2>

			{visibleTools.length === 0 ? (
				<p className="mt-5 text-sm text-muted-foreground">
					No tool activity in this range.
				</p>
			) : (
				<ol className="mt-3 flex flex-col">
					{visibleTools.map((tool, index) => {
						const success = getOutcomeCount(tool, "success");
						const error = getOutcomeCount(tool, "error");
						const denied = getOutcomeCount(tool, "denied");
						return (
							<li key={tool.tool}>
								<button
									type="button"
									onClick={() => onSelectTool(tool.tool)}
									aria-label={`${tool.tool}: ${tool.totalCalls} calls, ${success} successful, ${error} errors, ${denied} denied. Filter Recent Activity by this tool.`}
									className="group -mx-2 grid w-[calc(100%+1rem)] grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
									<span className="flex min-w-0 items-center justify-between gap-3">
										<span className="truncate font-mono text-xs font-medium">{tool.tool}</span>
										<span className="text-xs font-semibold tabular-nums">{tool.totalCalls}</span>
									</span>
									<span aria-hidden="true" />
									<span className="block h-1.5 overflow-hidden rounded-full bg-muted">
										<span
											aria-hidden="true"
											className="block h-full rounded-full bg-foreground/40"
											style={{ width: `${Math.max(4, (tool.totalCalls / maxCalls) * 100)}%` }}
										/>
									</span>
									{error + denied > 0 && (
										<>
											<span aria-hidden="true" />
											<span className="flex flex-wrap items-center gap-x-3 text-xs">
												{error > 0 && (
													<span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300">
														<CircleAlert className="size-3.5" aria-hidden />
														<span className="tabular-nums">{error} {error === 1 ? "error" : "errors"}</span>
													</span>
												)}
												{denied > 0 && (
													<span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
														<Ban className="size-3.5" aria-hidden />
														<span className="tabular-nums">{denied} denied</span>
													</span>
												)}
											</span>
										</>
									)}
								</button>
							</li>
						);
					})}
				</ol>
			)}

			{rankedTools.length > 10 ? (
				<KnButton
					variant="ghost"
					size="sm"
					icon={showAll ? <ChevronUp /> : <ChevronDown />}
					onClick={() => setShowAll((current) => !current)}
					aria-expanded={showAll}
					className="mt-3 w-full text-xs"
				>
					{showAll ? "Show top 10" : `Show all ${rankedTools.length}`}
				</KnButton>
			) : null}
		</section>
	);
}
