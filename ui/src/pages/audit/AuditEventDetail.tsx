import type { MouseEvent, ReactNode } from "react";
import { ChevronDown, ChevronUp, GanttChart } from "lucide-react";
import { Badge } from "@/ui/components/ui/knowns/badge";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { CodeBlock } from "@/ui/components/ui/knowns/code-block/code-block";
import { Sheet } from "@/ui/components/ui/knowns/sheet";
import { relativeTime } from "@/ui/components/ui/knowns/blocks/application/app-feed-utils";
import { navigateTo } from "@/ui/lib/navigation";
import { focusRing } from "@/ui/lib/knowns/utils";
import { cn } from "@/ui/lib/utils";
import { useIsMobile } from "@/ui/hooks/useMobile";
import {
	type AuditRow,
	classMeta,
	eventJson,
	exactTime,
	formatDuration,
	parseEntityRef,
	parseJsonText,
	resultMeta,
	toolLabel,
} from "./auditFormat";
import { ResultIcon } from "./AuditEventList";

export function AuditEventSheet({
	row,
	now,
	position,
	onClose,
	onStep,
	onViewSession,
}: {
	row: AuditRow | null;
	now: number;
	/** 1-based place of the row in the shown list, and the list length. */
	position: { index: number; total: number } | null;
	onClose: () => void;
	onStep: (delta: -1 | 1) => void;
	/** Opens the agent session this call belongs to as a trace waterfall. */
	onViewSession: (row: AuditRow) => void;
}) {
	const isMobile = useIsMobile();
	const event = row?.event;

	return (
		<Sheet
			open={row !== null}
			onOpenChange={(open) => !open && onClose()}
			side={isMobile ? "bottom" : "right"}
			size="lg"
			label="Audit event"
			title={
				event ? (
					<span className="flex min-w-0 items-center gap-2">
						<ResultIcon result={event.result} />
						<span className="truncate font-mono">{toolLabel(event)}</span>
					</span>
				) : (
					"Audit event"
				)
			}
			description={row ? exactTime(row.at) : undefined}
			footer={
				position && (
					<div className="flex w-full items-center justify-between gap-2">
						<span className="text-xs tabular-nums text-muted-foreground">
							{position.index} of {position.total}
						</span>
						<div className="flex gap-1.5">
							<KnButton
								variant="ghost"
								size="sm"
								icon={<ChevronUp />}
								disabled={position.index <= 1}
								onClick={() => onStep(-1)}
							>
								Newer
							</KnButton>
							<KnButton
								variant="ghost"
								size="sm"
								icon={<ChevronDown />}
								disabled={position.index >= position.total}
								onClick={() => onStep(1)}
							>
								Older
							</KnButton>
						</div>
					</div>
				)
			}
		>
			{row && <AuditEventDetail row={row} now={now} onClose={onClose} onViewSession={onViewSession} />}
		</Sheet>
	);
}

function AuditEventDetail({
	row,
	now,
	onClose,
	onViewSession,
}: {
	row: AuditRow;
	now: number;
	onClose: () => void;
	onViewSession: (row: AuditRow) => void;
}) {
	const { event, at } = row;
	const result = resultMeta(event.result);
	const kind = classMeta(event.actionClass);
	const refs = (event.entityRefs ?? []).map(parseEntityRef);
	const args = Object.entries(event.argumentSummary ?? {});
	const errorJson = event.errorMessage ? parseJsonText(event.errorMessage) : null;
	const rel = relativeTime(at, now);

	const go = (href: string) => (clickEvent: MouseEvent<HTMLAnchorElement>) => {
		if (clickEvent.metaKey || clickEvent.ctrlKey || clickEvent.shiftKey || clickEvent.button !== 0) return;
		clickEvent.preventDefault();
		onClose();
		navigateTo(href);
	};

	return (
		<div className="flex flex-col gap-6 pb-2 text-[13px]" data-testid="audit-event-detail">
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge tone={result.tone} dot>
					{result.label}
				</Badge>
				<Badge variant="outline" tone={kind.tone}>
					{kind.label}
				</Badge>
				{event.dryRun && (
					<Badge variant="outline" tone="warning">
						Dry run
					</Badge>
				)}
				<KnButton variant="secondary" size="sm" icon={<GanttChart />} onClick={() => onViewSession(row)} className="ml-auto">
					View session
				</KnButton>
			</div>

			<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
				<Fact label="Caller">MCP tool call</Fact>
				<Fact label="Tool">
					<span className="font-mono">{event.toolName}</span>
				</Fact>
				{event.action && (
					<Fact label="Action">
						<span className="font-mono">{event.action}</span>
					</Fact>
				)}
				<Fact label="Items">
					{refs.length === 0 ? (
						<span className="text-muted-foreground">None recorded</span>
					) : (
						<span className="flex flex-wrap gap-x-3 gap-y-1">
							{refs.map((ref) =>
								ref.href ? (
									<a
										key={ref.raw}
										href={ref.href}
										onClick={go(ref.href)}
										className={cn("rounded-sm font-medium text-foreground underline-offset-2 hover:underline", focusRing)}
									>
										{ref.label}
									</a>
								) : (
									<span key={ref.raw} className="font-medium">
										{ref.label}
									</span>
								),
							)}
						</span>
					)}
				</Fact>
				<Fact label="When">
					<span>
						{exactTime(at)}
						<span className="text-muted-foreground"> ({rel === "now" ? "just now" : `${rel} ago`})</span>
					</span>
				</Fact>
				<Fact label="Duration">
					<span className="tabular-nums">{formatDuration(event.durationMs)}</span>
				</Fact>
				{event.projectRoot && (
					<Fact label="Project">
						<span className="break-all font-mono text-xs">{event.projectRoot}</span>
					</Fact>
				)}
			</dl>

			{event.errorMessage && (
				<DetailSection title={event.result === "denied" ? "Why it was denied" : "Error"}>
					{errorJson !== null ? (
						<CodeBlock
							code={JSON.stringify(errorJson, null, 2)}
							language="json"
							label="Error payload"
							collapseAfter={12}
							defaultWrap
						/>
					) : (
						<p className="whitespace-pre-wrap break-words rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-red-700 dark:text-red-300">
							{event.errorMessage}
						</p>
					)}
				</DetailSection>
			)}

			<DetailSection title="Arguments" hint="Large text fields are logged by size only.">
				{args.length === 0 ? (
					<p className="text-muted-foreground">No arguments recorded.</p>
				) : (
					<dl className="divide-y divide-border overflow-hidden rounded-lg border border-border">
						{args.map(([key, value]) => (
							<ArgumentRow key={key} name={key} value={value} />
						))}
					</dl>
				)}
			</DetailSection>

			<DetailSection title="Raw event">
				<CodeBlock
					code={eventJson(event)}
					language="json"
					label="JSON"
					collapseAfter={10}
					defaultWrap
					aria-label="Raw audit event"
				/>
			</DetailSection>
		</div>
	);
}

function ArgumentRow({ name, value }: { name: string; value: string }) {
	const json = parseJsonText(value);
	return (
		<div className="grid gap-1 px-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
			<dt className="truncate font-mono text-xs text-muted-foreground" title={name}>
				{name}
			</dt>
			<dd className="min-w-0">
				{json !== null ? (
					<CodeBlock code={JSON.stringify(json, null, 2)} language="json" collapseAfter={8} defaultWrap flush />
				) : (
					<span className="whitespace-pre-wrap break-words font-mono text-xs">{value}</span>
				)}
			</dd>
		</div>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</>
	);
}

function DetailSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-[13px] font-medium text-foreground">{title}</h3>
				{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			</div>
			{children}
		</section>
	);
}
