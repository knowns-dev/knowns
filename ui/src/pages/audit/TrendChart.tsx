import { useMemo } from "react";
import type { AuditDailyBucket } from "@/ui/api/client";
import { Chart } from "@/ui/components/ui/knowns/chart/chart";
import { focusRing } from "@/ui/lib/knowns/utils";
import { cn } from "@/ui/lib/utils";
import { useIsMobile } from "../../hooks/useMobile";
import { busiestDays, coveredWindow, toTrendPoints } from "./analyticsMath";

const MOBILE_MAX_BARS = 30;

const shortDate = (date: string) =>
	new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

const calls = (value: number) => `${value} ${value === 1 ? "call" : "calls"}`;

/**
 * Calls per day as stacked bars: what went through, and what needs a look (errors and denials). It shows only the
 * days the retained log covers, says how many earlier days it does not, and never scrolls sideways: on a phone a long
 * range is summed by week. The busiest days under the chart open Recent Activity for that day.
 */
export function TrendChart({ buckets, onSelectDay }: { buckets: AuditDailyBucket[]; onSelectDay: (date: string) => void }) {
	const isMobile = useIsMobile();
	const { window: covered, earlierUncovered } = useMemo(() => coveredWindow(buckets), [buckets]);
	const weekly = isMobile && covered.length > MOBILE_MAX_BARS;
	const points = useMemo(() => toTrendPoints(covered, weekly), [covered, weekly]);
	const data = useMemo(
		() => points.map((p) => ({ day: shortDate(p.date), succeeded: p.succeeded, attention: p.attention })),
		[points],
	);
	const busiest = useMemo(() => busiestDays(covered), [covered]);

	return (
		<section aria-labelledby="audit-trend-heading" className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 id="audit-trend-heading" className="text-sm font-semibold">
					Calls per {weekly ? "week" : "day"}
				</h2>
				{weekly && <p className="text-xs text-muted-foreground">Weekly totals, each bar starts on the date shown.</p>}
			</div>

			<div className="mt-4">
				<Chart
					type="bar"
					stacked
					label={`MCP calls per ${weekly ? "week" : "day"}`}
					data={data}
					x="day"
					height={220}
					series={[
						{ key: "succeeded", label: "Succeeded", color: "var(--chart-1)" },
						{ key: "attention", label: "Needs attention", color: "var(--chart-5)" },
					]}
					empty="No calls in this range"
				/>
			</div>

			{earlierUncovered > 0 && (
				<p className="mt-3 text-xs text-muted-foreground">
					{earlierUncovered} earlier {earlierUncovered === 1 ? "day has" : "days have"} no retained history.
				</p>
			)}

			{busiest.length > 0 && (
				<div className="mt-4 border-t pt-3">
					<h3 className="text-xs font-medium text-muted-foreground">Busiest days</h3>
					<ul className="mt-2 flex flex-wrap gap-2">
						{busiest.map((bucket) => (
							<li key={bucket.date}>
								<button
									type="button"
									onClick={() => onSelectDay(bucket.date)}
									aria-label={`${shortDate(bucket.date)}: ${calls(bucket.totalCalls)}${
										bucket.needsAttention ? `, ${bucket.needsAttention} need attention` : ""
									}. Open Recent Activity for this day.`}
									className={cn(
										"inline-flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] shadow-[0_0_0_1px_var(--border)] transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted pointer-coarse:min-h-10",
										focusRing,
									)}
								>
									<span className="font-medium">{shortDate(bucket.date)}</span>
									<span className="tabular-nums text-muted-foreground">{calls(bucket.totalCalls)}</span>
									{bucket.needsAttention > 0 && (
										<span className="tabular-nums text-red-700 dark:text-red-300">{bucket.needsAttention} need attention</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
