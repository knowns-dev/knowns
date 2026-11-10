import { useMemo } from "react";
import { AlertCircle, CheckCircle2, CircleDot, Search, ShieldAlert } from "lucide-react";
import { Badge } from "@/ui/components/ui/knowns/badge";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Combobox, type ComboboxDotTone, type ComboboxOption } from "@/ui/components/ui/knowns/combobox";
import { Input } from "@/ui/components/ui/knowns/input";
import { Tooltip } from "@/ui/components/ui/knowns/tooltip";
import { groupByDay, relativeTime } from "@/ui/components/ui/knowns/blocks/application/app-feed-utils";
import { focusRing } from "@/ui/lib/knowns/utils";
import { cn } from "@/ui/lib/utils";
import {
	type AuditRow,
	CLASS_META,
	classMeta,
	errorSummary,
	exactTime,
	formatDuration,
	formatRangeDay,
	parseEntityRef,
	projectName,
	RESULT_META,
	resultMeta,
	toolLabel,
} from "./auditFormat";

const ALL = "all";

export interface AuditFilters {
	query: string;
	tool: string;
	result: string;
	actionClass: string;
	day: string;
}

export function AuditToolbar({
	filters,
	tools,
	shown,
	loaded,
	onChange,
}: {
	filters: AuditFilters;
	/** Tool names with their all-time call counts, most used first. */
	tools: Array<{ name: string; count?: number }>;
	shown: number;
	loaded: number;
	onChange: (patch: Partial<AuditFilters>) => void;
}) {
	const toolOptions: ComboboxOption[] = [
		{ value: ALL, label: "All tools" },
		...tools.map((tool) => ({
			value: tool.name,
			label: tool.name,
			supportingText: tool.count !== undefined ? String(tool.count) : undefined,
		})),
	];
	const resultOptions: ComboboxOption[] = [
		{ value: ALL, label: "All results" },
		...Object.entries(RESULT_META).map(([value, meta]) => ({
			value,
			label: meta.label,
			dot: meta.tone as ComboboxDotTone,
		})),
	];
	const classOptions: ComboboxOption[] = [
		{ value: ALL, label: "All kinds" },
		...Object.entries(CLASS_META).map(([value, meta]) => ({ value, label: meta.label })),
	];
	const narrowed = shown !== loaded;

	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
			<Input
				type="search"
				aria-label="Search audit events"
				placeholder="Search tool, item, argument or error"
				icon={<Search />}
				value={filters.query}
				onChange={(event) => onChange({ query: event.target.value })}
				className="w-full sm:w-72"
			/>
			<div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
				<Combobox
					aria-label="Filter by tool"
					searchable
					value={filters.tool || ALL}
					onValueChange={(value) => onChange({ tool: value === ALL ? "" : value })}
					options={toolOptions}
					className="min-w-0 text-sm sm:w-40"
				/>
				<Combobox
					aria-label="Filter by result"
					value={filters.result || ALL}
					onValueChange={(value) => onChange({ result: value === ALL ? "" : value })}
					options={resultOptions}
					className="min-w-0 text-sm sm:w-36"
				/>
				<Combobox
					aria-label="Filter by kind"
					value={filters.actionClass || ALL}
					onValueChange={(value) => onChange({ actionClass: value === ALL ? "" : value })}
					options={classOptions}
					className="min-w-0 text-sm sm:w-32"
				/>
			</div>
			{filters.day && (
				<Badge
					variant="outline"
					size="lg"
					onRemove={() => onChange({ day: "" })}
					removeLabel={`Clear the ${formatRangeDay(filters.day)} filter`}
					className="self-start sm:self-auto"
				>
					{formatRangeDay(filters.day)}
				</Badge>
			)}
			<span className="text-xs tabular-nums text-muted-foreground sm:ml-auto" aria-live="polite">
				{narrowed ? `${shown} of ${loaded} events loaded` : `${loaded} events loaded`}
			</span>
		</div>
	);
}

const RESULT_ICON: Record<string, { icon: typeof CheckCircle2; className: string }> = {
	success: { icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
	error: { icon: AlertCircle, className: "text-red-600 dark:text-red-400" },
	denied: { icon: ShieldAlert, className: "text-amber-600 dark:text-amber-400" },
};

export function ResultIcon({ result, className }: { result: string; className?: string }) {
	const meta = RESULT_ICON[result] ?? { icon: CircleDot, className: "text-muted-foreground" };
	const Icon = meta.icon;
	return <Icon aria-hidden="true" className={cn("size-4 shrink-0", meta.className, className)} />;
}

export function AuditEventList({
	rows,
	now,
	selectedKey,
	onSelect,
	hasMore,
	loadingMore,
	onLoadMore,
	emptyText,
}: {
	rows: AuditRow[];
	now: number;
	selectedKey: string | null;
	onSelect: (row: AuditRow) => void;
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	emptyText: string;
}) {
	const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
	const groups = useMemo(() => groupByDay(rows, now, timeZone), [rows, now, timeZone]);

	if (rows.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
				{emptyText}
			</div>
		);
	}

	return (
		<section
			aria-label="Audit events"
			className="rounded-xl border border-border bg-card sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overscroll-contain"
		>
			{groups.map((group) => (
				<div key={group.key}>
					<h3 className="sticky -top-5 z-[1] sm:top-0 flex items-center gap-1.5 border-b border-border bg-card/95 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
						<span className="font-medium">{group.label}</span>
						<span className="tabular-nums">
							{group.items.length} {group.items.length === 1 ? "event" : "events"}
						</span>
					</h3>
					<ul className="divide-y divide-border">
						{group.items.map((row) => (
							<li key={row.key}>
								<AuditEventRow
									row={row}
									now={now}
									selected={row.key === selectedKey}
									onSelect={() => onSelect(row)}
								/>
							</li>
						))}
					</ul>
				</div>
			))}
			{hasMore && (
				<div className="flex justify-center border-t border-border p-3">
					<KnButton variant="quiet" size="sm" loading={loadingMore} onClick={onLoadMore}>
						{loadingMore ? "Loading" : "Show older"}
					</KnButton>
				</div>
			)}
		</section>
	);
}

function AuditEventRow({
	row,
	now,
	selected,
	onSelect,
}: {
	row: AuditRow;
	now: number;
	selected: boolean;
	onSelect: () => void;
}) {
	const { event, at } = row;
	const refs = (event.entityRefs ?? []).map(parseEntityRef);
	const result = resultMeta(event.result);
	const kind = classMeta(event.actionClass);
	const rel = relativeTime(at, now);
	const project = projectName(event.projectRoot);
	const exact = exactTime(at);

	return (
		<button
			type="button"
			data-audit-event={toolLabel(event)}
			aria-current={selected ? "true" : undefined}
			aria-label={`${toolLabel(event)}, ${result.label}${refs.length ? `, ${refs.map((ref) => ref.label).join(", ")}` : ""}, ${exact}`}
			onClick={onSelect}
			className={cn(
				"grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2.5 text-left",
				"transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/50",
				focusRing,
				"focus-visible:ring-inset",
				selected && "bg-muted/60",
			)}
		>
			<ResultIcon result={event.result} className="mt-0.5" />
			<span className="min-w-0">
				<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-5">
					<span className="truncate font-mono font-medium text-foreground">{toolLabel(event)}</span>
					{refs.length > 0 && (
						<span className="min-w-0 truncate text-muted-foreground">
							on{" "}
							<span className="font-medium text-foreground">
								{refs[0]!.label}
								{refs.length > 1 ? ` +${refs.length - 1}` : ""}
							</span>
						</span>
					)}
				</span>
				<span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-5 text-muted-foreground">
					{event.result !== "success" && (
						<Badge size="sm" tone={result.tone}>
							{result.label}
						</Badge>
					)}
					<Badge size="sm" variant="outline" tone={kind.tone}>
						{kind.label}
					</Badge>
					{event.dryRun && (
						<Badge size="sm" tone="warning" variant="outline">
							Dry run
						</Badge>
					)}
					{event.errorMessage ? (
						<span className="min-w-0 flex-1 basis-40 truncate text-red-600 dark:text-red-400">
							{errorSummary(event)}
						</span>
					) : (
						<>
							{project && <span className="truncate">{project}</span>}
							<span className="tabular-nums">{formatDuration(event.durationMs)}</span>
						</>
					)}
				</span>
			</span>
			<Tooltip content={exact} side="left">
				<time
					dateTime={new Date(at).toISOString()}
					title={exact}
					className="pt-px text-xs leading-5 tabular-nums text-muted-foreground"
				>
					{rel === "now" ? "Just now" : rel}
				</time>
			</Tooltip>
		</button>
	);
}
