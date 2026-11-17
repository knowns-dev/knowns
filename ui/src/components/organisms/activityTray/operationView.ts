// How one operation reads in the tray. Everything the tray needs from an operation goes through
// this one mapping (buttons come from the flags, never from the kind), so a different capsule
// (the Activity Stack "operation" kind) is a swap of the renderer, not of the rules.

import { isTerminalOperation, type Operation } from "@/ui/models/operation";

export type OperationAction = "cancel" | "retry" | "dismiss";

export interface OperationView {
	id: string;
	title: string;
	/** The line under the title: the outcome or the reason, display text. */
	detail: string | null;
	/** busy: spinner or bar. cancelling is busy, not an error. */
	tone: "busy" | "done" | "failed" | "stopped";
	/** 0..1, or null for an indeterminate operation. */
	fraction: number | null;
	/** "3 / 10" or null. */
	count: string | null;
	actions: OperationAction[];
	/** A stopped Qdrant reindex starts over, so it is "Run again", never "Resume". */
	retryLabel: string;
}

export function operationView(op: Operation): OperationView {
	const p = op.progress;
	const fraction = p && p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : null;
	const actions: OperationAction[] = [];
	if (op.cancellable) actions.push("cancel");
	if (op.retryable) actions.push("retry");
	if (isTerminalOperation(op)) actions.push("dismiss");
	const tone: OperationView["tone"] =
		op.state === "failed"
			? "failed"
			: op.state === "done"
				? "done"
				: op.state === "cancelled"
					? "stopped"
					: "busy";
	return {
		id: op.id,
		title: op.title,
		// A failure shows its one-line error first, then the counts and reasons from the message.
		detail: op.state === "failed" ? [op.error, op.message].filter(Boolean).join(" · ") || null : op.message,
		tone,
		fraction,
		count: p && p.total > 0 ? `${Math.min(p.done, p.total)} / ${p.total}` : null,
		actions,
		retryLabel: "Run again",
	};
}
