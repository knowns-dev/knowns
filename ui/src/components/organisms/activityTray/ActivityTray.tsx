/**
 * The Activity Tray: every running, queued or just finished operation of this server and its daemon,
 * in the corner of the app, as the Knowns UI Pro Activity Stack. The rules for what each row shows
 * and which buttons it has live in toActivityItem.ts; the state is OperationsContext.
 */

import { useCallback, useMemo, useState } from "react";
import { ActivityStack } from "../../ui/knowns/blocks/agents/activity-stack";
import { useOperations } from "../../../contexts/OperationsContext";
import { toast } from "../../ui/sonner";
import { toActivityItem } from "./toActivityItem";

export function ActivityTray() {
	const { operations, cancel, retry, dismiss, hideHere } = useOperations();
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

	// One request at a time per row: the button is disabled while it is in flight.
	const run = useCallback((id: string, fn: () => Promise<void>) => {
		setPending((p) => new Set(p).add(id));
		fn()
			.catch((error) => toast.error(error instanceof Error ? error.message : "That did not work"))
			.finally(() =>
				setPending((p) => {
					const next = new Set(p);
					next.delete(id);
					return next;
				}),
			);
	}, []);

	const items = useMemo(
		() =>
			operations.map((op) =>
				toActivityItem(op, {
					pending,
					cancel: (id) => run(id, () => cancel(id)),
					retry: (id) => run(id, () => retry(id)),
					dismissOnServer: (id) => run(id, () => dismiss(id)),
					hideHere,
				}),
			),
		[operations, pending, run, cancel, retry, dismiss, hideHere],
	);

	if (items.length === 0) return null;
	return (
		<div className="fixed right-4 bottom-4 z-50 w-80" data-testid="activity-tray">
			<ActivityStack items={items} />
		</div>
	);
}
