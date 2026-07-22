import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, XCircle } from "lucide-react";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import type { TaskLifecycleResponse, TaskLifecycleResult } from "@/ui/models/taskLifecycle";
import { TASK_LIFECYCLE_REASON_LABELS, formatLifecycleState } from "@/ui/models/taskLifecycle";
import { cn } from "@/ui/lib/utils";

interface TaskLifecycleDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	response: TaskLifecycleResponse | null;
	loading?: boolean;
	error?: string | null;
	confirmLabel?: string;
	onConfirm: () => void;
	allowCancelWhileLoading?: boolean;
}

function ResultRow({ item, execute }: { item: TaskLifecycleResult; execute: boolean }) {
	const repairPending = item.reasons.some((reason) => reason.code === "operation_failed")
		|| item.warnings?.some((warning) => warning.code === "event_delivery_failed") === true;
	const skipped = !item.changed && !repairPending && (!item.eligible || item.reasons.length > 0);
	const label = repairPending ? "Repair pending" : item.changed ? "Changed" : skipped ? "Skipped" : execute ? "Unchanged" : "Eligible";
	return (
		<li className="rounded-md border bg-card p-3" data-testid={`lifecycle-item-${item.taskId}`}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="font-mono text-xs font-medium">#{item.taskId}</div>
					<div className="mt-1 text-xs text-muted-foreground">
						{formatLifecycleState(item.before)} → {formatLifecycleState(item.after)}
					</div>
				</div>
				<span className={cn(
					"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
					repairPending || skipped ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				)}>
					{repairPending ? <RotateCcw className="h-3 w-3" /> : skipped ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
					{label}
				</span>
			</div>

			{item.deadline && (
				<div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground" data-testid="lifecycle-deadline">
					<Clock3 className="h-3 w-3" /> Eligible after {item.deadline.toLocaleString()}
				</div>
			)}
			{(item.completedAt || item.archivedAt) && (
				<div className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="lifecycle-timestamps">
					{item.completedAt && <div>Completed {item.completedAt.toLocaleString()}</div>}
					{item.archivedAt && <div>Archived {item.archivedAt.toLocaleString()}</div>}
				</div>
			)}

			{item.reasons?.length > 0 && (
				<ul className="mt-2 space-y-1" data-testid="lifecycle-reasons">
					{item.reasons.map((reason, index) => (
						<li key={`${reason.code}-${reason.relatedTaskId || index}`} className="text-xs text-amber-700 dark:text-amber-300">
							<span className="font-medium">{TASK_LIFECYCLE_REASON_LABELS[reason.code]}</span>
							{reason.message && reason.message !== TASK_LIFECYCLE_REASON_LABELS[reason.code] ? ` — ${reason.message}` : ""}
							{reason.relatedTaskId ? ` (#${reason.relatedTaskId})` : ""}
							{reason.deadline ? ` · ${reason.deadline.toLocaleString()}` : ""}
						</li>
					))}
				</ul>
			)}

			{item.warnings?.map((warning, index) => (
				<div key={`${warning.code}-${index}`} className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-xs" data-testid="lifecycle-warning">
					<div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
						<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<div>
							<div className="font-medium">{warning.message}</div>
							{warning.references && warning.references.length > 0 && (
								<div className="mt-1 break-all font-mono opacity-80">{warning.references.join(", ")}</div>
							)}
						</div>
					</div>
				</div>
			))}

			{item.event && (
				<div className="mt-2 text-[11px] text-muted-foreground" data-testid="lifecycle-event">
					Event {item.event.id} · {item.event.at.toLocaleString()}
				</div>
			)}
		</li>
	);
}

export function TaskLifecycleDialog({
	open,
	onOpenChange,
	title,
	description,
	response,
	loading = false,
	error,
	confirmLabel = "Confirm",
	onConfirm,
	allowCancelWhileLoading = false,
}: TaskLifecycleDialogProps) {
	const eligible = response?.items.filter((item) => item.eligible && item.reasons.length === 0).length ?? 0;
	const canExecute = !!response && !response.execute && eligible > 0;
	const repairPending = !!response?.failedTaskId
		|| response?.items.some((item) => item.reasons.some((reason) => reason.code === "operation_failed")) === true;
	const canRetry = !!response?.execute && repairPending;

	return (
		<Dialog open={open} onOpenChange={(next) => (!loading || allowCancelWhileLoading) && onOpenChange(next)}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden p-0" data-testid="task-lifecycle-dialog">
				<DialogHeader className="border-b px-6 py-5 pr-12">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="overflow-y-auto px-6 py-4">
					{error && (
						<div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
							{error}
						</div>
					)}

					{response && (
						<>
							<div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="lifecycle-progress">
								<span>Processed {response.processed}/{response.items.length}</span>
								<span>Changed {response.changed}</span>
								<span>{repairPending ? "Repair pending" : response.completed ? "Complete" : "Interrupted"}</span>
								{response.failedTaskId && <span className="text-destructive">Failed at #{response.failedTaskId}</span>}
							</div>
							<ul className="space-y-2" data-testid="lifecycle-items">
								{response.items.map((item) => <ResultRow key={`${item.taskId}-${item.operation}`} item={item} execute={response.execute} />)}
							</ul>
						</>
					)}
				</div>

				<DialogFooter className="border-t px-6 py-4">
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading && !allowCancelWhileLoading}>Cancel</Button>
					{(canExecute || canRetry) && (
						<Button onClick={onConfirm} disabled={loading} data-testid="lifecycle-confirm">
							{canRetry && <RotateCcw className="mr-2 h-4 w-4" />}
							{loading ? "Working…" : canRetry ? "Retry remaining" : confirmLabel}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
