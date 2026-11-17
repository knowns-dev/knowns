// Operation -> Activity Stack item. The only place that knows the stack's "operation" kind.
// Buttons come from the operation's flags: cancellable -> Cancel, retryable -> "Run again".

import { Link } from "@tanstack/react-router";
import type { ActivityItem, OperationAction } from "@/ui/components/ui/knowns/blocks/agents/activity-stack";
import { agesOut } from "@/ui/lib/operationsStore";
import type { Operation } from "@/ui/models/operation";

export type PendingAction = "cancel" | "retry" | "dismiss";

export interface TrayHandlers {
	cancel: (id: string) => void;
	retry: (id: string) => void;
	/** The person pressed Dismiss: remove the row on the server (for everyone). */
	dismissOnServer: (id: string) => void;
	/** A finished row aged out, or Dismiss on one that nobody can run again: hide it in THIS tab only. */
	hideHere: (id: string) => void;
	/** Requests in flight, by operation id. */
	pending: ReadonlyMap<string, PendingAction>;
}

/**
 * The one line a failed row shows. The message (counts and the first reasons: "1 archived, 1 not
 * changed: #ID Task must be done") comes first because the line is cut at the card's width and that
 * is the part a person needs; the technical error follows.
 */
export const failureText = (op: Operation): string => [op.message, op.error].filter(Boolean).join(" · ");

/** The failed row's line, with a real link to where the cause can be looked into (spec D3). */
function failureDetail(op: Operation) {
	const text = failureText(op);
	// The link comes first: the line is cut at the card's width, and the way out must stay visible.
	// The title carries the whole text for the cut collapsed line; the open card wraps it in full (see `error`).
	return (
		<span title={text || undefined}>
			<Link to="/runtime" className="underline underline-offset-2">
				Open Runtime
			</Link>
			{text ? ` · ${text}` : null}
		</span>
	);
}

export function toActivityItem(op: Operation, h: TrayHandlers): ActivityItem {
	const inFlight = h.pending.get(op.id);
	const busy = inFlight !== undefined;
	// The moment Cancel is pressed the row reads Cancelling, before the server's answer: a batch
	// cancel waits for the chunk in progress, and the row must not still say Running meanwhile.
	const state = inFlight === "cancel" && (op.state === "running" || op.state === "queued") ? "cancelling" : op.state;
	const actions: OperationAction[] = [];
	if (op.cancellable) {
		actions.push({ id: "cancel", label: "Cancel", variant: "destructive", disabled: busy, onSelect: () => h.cancel(op.id) });
	}
	if (op.retryable) {
		// A stopped Qdrant reindex starts over, so this is "Run again", never "Resume".
		actions.push({ id: "retry", label: "Run again", disabled: busy, onSelect: () => h.retry(op.id) });
	}
	const failed = state === "failed";
	return {
		kind: "operation",
		id: op.id,
		title: op.title,
		// A failure puts its reason on the collapsed line too (not only in the open card) and links to Runtime.
		message: failed ? failureDetail(op) : (op.message ?? undefined),
		state,
		progress: op.progress,
		// The open card shows this wrapped, never cut: the reason a person came to read.
		error: failed ? failureText(op) || undefined : undefined,
		actions,
		// A finished row keeps its final duration; one that took under a second would read 0:00, which
		// looks like a clock that never ran, so it shows no clock at all.
		startedAt: op.finishedAt && op.finishedAt - op.startedAt < 1000 ? undefined : new Date(op.startedAt),
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
