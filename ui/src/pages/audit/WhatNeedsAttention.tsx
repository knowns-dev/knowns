import { useEffect, useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronUp, CircleAlert, CircleCheck } from "lucide-react";
import { auditApi, type AuditAnalytics, type AuditEvent } from "@/ui/api/client";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { relativeTime } from "@/ui/components/ui/knowns/blocks/application/app-feed-utils";
import { focusRing } from "@/ui/lib/knowns/utils";
import { cn } from "@/ui/lib/utils";
import { attentionRows, type AttentionRow } from "./analyticsMath";

/** How many failing calls of each kind are read for the message and last-seen columns. */
const FAILING_LIMIT = 200;
const SHOWN = 6;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What is failing, tool by tool: error and denial counts for the range, the message that comes up most and when the
 * tool last failed. A row opens Recent Activity for that tool and result. Counts come from the range analytics; the
 * message and last-seen time come from the latest failing calls in the same range.
 */
export function WhatNeedsAttention({
	analytics,
	onSelect,
}: {
	analytics: AuditAnalytics;
	onSelect: (tool: string, result: "error" | "denied") => void;
}) {
	const [failing, setFailing] = useState<AuditEvent[] | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [failed, setFailed] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	const { rangeStart, rangeEnd, timezone } = analytics;
	useEffect(() => {
		let cancelled = false;
		setFailed(false);
		const query = { limit: FAILING_LIMIT, from: rangeStart, to: rangeEnd, timezone };
		Promise.all([auditApi.recent({ ...query, result: "error" }), auditApi.recent({ ...query, result: "denied" })])
			.then(([errors, denied]) => {
				if (cancelled) return;
				setFailing([...errors.events, ...denied.events]);
				setTruncated(errors.events.length >= FAILING_LIMIT || denied.events.length >= FAILING_LIMIT);
				setNow(Date.now());
			})
			.catch(() => {
				if (cancelled) return;
				setFailing([]);
				setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [rangeStart, rangeEnd, timezone]);

	const rows = useMemo(() => attentionRows(analytics.tools, failing ?? []), [analytics.tools, failing]);
	const visible = showAll ? rows : rows.slice(0, SHOWN);

	return (
		<section aria-labelledby="audit-attention-heading" className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 id="audit-attention-heading" className="text-sm font-semibold">
					What needs attention
				</h2>
				{rows.length > 0 && <p className="text-xs text-muted-foreground">Select a tool to see its failing calls</p>}
			</div>

			{rows.length === 0 ? (
				<p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
					<CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
					Nothing needs attention in this range.
				</p>
			) : (
				<ul className="mt-3 flex flex-col">
					{visible.map((row) => (
						<li key={row.tool}>
							<AttentionItem row={row} now={now} loading={failing === null} onSelect={onSelect} />
						</li>
					))}
				</ul>
			)}

			{rows.length > SHOWN && (
				<KnButton
					variant="ghost"
					size="sm"
					icon={showAll ? <ChevronUp /> : <ChevronDown />}
					onClick={() => setShowAll((current) => !current)}
					aria-expanded={showAll}
					className="mt-2 w-full text-xs"
				>
					{showAll ? `Show top ${SHOWN}` : `Show all ${rows.length}`}
				</KnButton>
			)}

			{(truncated || failed) && rows.length > 0 && (
				<p className="mt-3 text-xs text-muted-foreground">
					{failed
						? "Messages and last seen could not be loaded; the counts are from the range totals."
						: `Messages and last seen read the latest ${FAILING_LIMIT} failing calls of each kind, so an older failure may show no message.`}
				</p>
			)}
		</section>
	);
}

function AttentionItem({
	row,
	now,
	loading,
	onSelect,
}: {
	row: AttentionRow;
	now: number;
	loading: boolean;
	onSelect: (tool: string, result: "error" | "denied") => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(row.tool, row.dominant)}
			aria-label={`${row.tool}: ${plural(row.errors, "error", "errors")}, ${row.denied} denied${
				row.topMessage ? `, most common: ${row.topMessage}` : ""
			}. Open Recent Activity for this tool.`}
			className={cn(
				"-mx-2 flex w-[calc(100%+1rem)] flex-col gap-1 rounded-lg px-2 py-2.5 text-left transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/60 sm:grid sm:grid-cols-[minmax(0,13rem)_auto_minmax(0,1fr)_auto] sm:items-baseline sm:gap-x-4",
				focusRing,
			)}
		>
			<span className="truncate font-mono text-[12.5px] font-medium">{row.tool}</span>
			<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
				{row.errors > 0 && (
					<span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300">
						<CircleAlert className="size-3.5" aria-hidden />
						<span className="tabular-nums">{plural(row.errors, "error", "errors")}</span>
					</span>
				)}
				{row.denied > 0 && (
					<span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
						<Ban className="size-3.5" aria-hidden />
						<span className="tabular-nums">{row.denied} denied</span>
					</span>
				)}
			</span>
			<span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
				{row.topMessage ? (
					<>
						{row.topMessage}
						{row.topMessageCount && row.topMessageCount > 1 ? <span className="tabular-nums"> ({row.topMessageCount}x)</span> : null}
					</>
				) : loading ? (
					"Loading..."
				) : (
					"No message loaded"
				)}
			</span>
			<span className="text-xs tabular-nums text-muted-foreground">
				{row.lastSeen ? `Last seen ${relativeTime(row.lastSeen, now)}` : ""}
			</span>
		</button>
	);
}
