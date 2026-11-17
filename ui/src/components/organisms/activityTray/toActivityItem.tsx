// Operation -> Activity Stack item. The only place that knows the stack's "operation" kind.
// Buttons come from the operation's flags: cancellable -> Cancel, retryable -> "Run again".

import { Link } from "@tanstack/react-router";
import type { ActivityItem, OperationAction } from "@/ui/components/ui/knowns/blocks/agents/activity-stack";
import { agesOut } from "@/ui/lib/operationsStore";
import type { Operation } from "@/ui/models/operation";

export interface TrayHandlers {
	cancel: (id: string) => void;
	retry: (id: string) => void;
	/** The person pressed Dismiss: remove the row on the server (for everyone). */
	dismissOnServer: (id: string) => void;
	/** A finished row aged out, or Dismiss on one that nobody can run again: hide it in THIS tab only. */
	hideHere: (id: string) => void;
	pending: ReadonlySet<string>;
}

/** The one line a failed row shows: the reason first, then the counts and reasons from the message. */
export const failureText = (op: Operation): string => [op.error, op.message].filter(Boolean).join(" · ");

/** The failed row's line, with a real link to where the cause can be looked into (spec D3). */
function failureDetail(op: Operation) {
	const text = failureText(op);
	return (
		<>
			{text}
			{text ? " " : null}
			<Link to="/runtime" className="underline underline-offset-2">
				Open Runtime
			</Link>
		</>
	);
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
	const failed = op.state === "failed";
	return {
		kind: "operation",
		id: op.id,
		title: op.title,
		// A failure puts its reason on the collapsed line too (not only in the open card) and links to Runtime.
		message: failed ? failureDetail(op) : (op.message ?? undefined),
		state: op.state,
		progress: op.progress,
		error: undefined,
		actions,
		startedAt: new Date(op.startedAt),
		finishedAt: op.finishedAt ? new Date(op.finishedAt) : undefined,
		// The stack calls this with no argument when its timer ends a finished row, and with the click
		// when the person presses Dismiss. The timer ends only rows that age out (done, and cancelled
		// with nothing left to run); a failed row, or a cancelled one with work left, waits for Dismiss.
		onDismiss: (clicked?: unknown) => {
			if (clicked === undefined) {
				if (agesOut(op)) h.hideHere(op.id);
				return;
			}
			if (agesOut(op)) h.hideHere(op.id);
			else h.dismissOnServer(op.id);
		},
	};
}
