// Operation -> Activity Stack item. The only place that knows the stack's "operation" kind.
// Buttons come from the operation's flags: cancellable -> Cancel, retryable -> "Run again".

import type { ActivityItem, OperationAction } from "@/ui/components/ui/knowns/blocks/agents/activity-stack";
import type { Operation } from "@/ui/models/operation";

export interface TrayHandlers {
	cancel: (id: string) => void;
	retry: (id: string) => void;
	/** The user pressed Dismiss on a failed row: remove it on the server. */
	dismissOnServer: (id: string) => void;
	/** A done or cancelled row aged out (the stack's timer): hide it in THIS tab only. */
	hideHere: (id: string) => void;
	pending: ReadonlySet<string>;
}

export function toActivityItem(op: Operation, h: TrayHandlers): ActivityItem {
	const busy = h.pending.has(op.id);
	const actions: OperationAction[] = [];
	if (op.cancellable) {
		actions.push({ id: "cancel", label: "Cancel", variant: "destructive", disabled: busy, onSelect: () => h.cancel(op.id) });
	}
	if (op.retryable) {
		// A stopped Qdrant reindex starts over, so this is "Run again", never "Resume".
		actions.push({ id: "retry", label: "Run again", disabled: busy, onSelect: () => h.retry(op.id) });
	}
	return {
		kind: "operation",
		id: op.id,
		title: op.title,
		message: op.message ?? undefined,
		state: op.state,
		progress: op.progress,
		error: op.error ?? undefined,
		actions,
		startedAt: new Date(op.startedAt),
		finishedAt: op.finishedAt ? new Date(op.finishedAt) : undefined,
		// done and cancelled age out through the stack's own timer (local hide only); a failed row is
		// removed only when the person presses Dismiss.
		onDismiss: () => (op.state === "failed" ? h.dismissOnServer(op.id) : h.hideHere(op.id)),
	};
}

