import { useState } from "react";
import type { AuditToolStats } from "@/ui/api/client";
import { Button } from "@/ui/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

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
				<>
					<div className="mt-4 grid grid-cols-[1.25rem_minmax(0,1fr)_4rem] gap-2 px-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
						<span aria-hidden="true" />
						<span>Tool / calls</span>
						<span className="grid grid-cols-3 gap-1 text-center">
							<span title="Success">S</span>
							<span title="Error">E</span>
							<span title="Denied">D</span>
						</span>
					</div>
					<ol className="mt-1 space-y-1.5">
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
										className="group grid min-h-12 w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
									>
										<span className="text-right text-[10px] tabular-nums text-muted-foreground">
											{index + 1}
										</span>
										<span className="min-w-0">
											<span className="flex items-center justify-between gap-2">
												<span className="truncate font-mono text-xs font-medium">
													{tool.tool}
												</span>
												<span className="text-xs font-semibold tabular-nums">
													{tool.totalCalls}
												</span>
											</span>
											<span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
												<span
													aria-hidden="true"
													className="block h-full rounded-full bg-[#2DA44E] transition-[width] motion-reduce:transition-none"
													style={{
														width: `${Math.max(
															4,
															(tool.totalCalls / maxCalls) * 100,
														)}%`,
													}}
												/>
											</span>
										</span>
										<span className="grid min-w-16 grid-cols-3 gap-1 text-center text-[9px] tabular-nums">
											<span
												className="text-[#1A7F37] dark:text-[#56D364]"
												title={`${success} successful`}
											>
												{success}
												<span className="sr-only"> successful</span>
											</span>
											<span
												className="text-[#CF222E] dark:text-[#FF7B72]"
												title={`${error} errors`}
											>
												{error}
												<span className="sr-only"> errors</span>
											</span>
											<span
												className="text-[#9A6700] dark:text-[#E3B341]"
												title={`${denied} denied`}
											>
												{denied}
												<span className="sr-only"> denied</span>
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				</>
			)}

			{rankedTools.length > 10 ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setShowAll((current) => !current)}
					aria-expanded={showAll}
					className="mt-3 min-h-10 w-full text-xs"
				>
					{showAll ? (
						<>
							<ChevronUp className="h-3.5 w-3.5" />
							Show top 10
						</>
					) : (
						<>
							<ChevronDown className="h-3.5 w-3.5" />
							Show all {rankedTools.length}
						</>
					)}
				</Button>
			) : null}
		</section>
	);
}
