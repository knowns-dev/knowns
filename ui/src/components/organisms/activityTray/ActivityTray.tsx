/**
 * The Activity Tray: every running, queued or just finished operation of this server and its daemon,
 * as the Knowns UI Pro Activity Stack, top right under the header (spec FR-1). The rules for what each
 * row shows and which buttons it has live in toActivityItem.tsx; the state is OperationsContext.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityStack } from "../../ui/knowns/blocks/agents/activity-stack";
import { useOperations } from "../../../contexts/OperationsContext";
import { toast } from "../../ui/sonner";
import { toActivityItem } from "./toActivityItem";

// Stack props that ship with the next Activity Stack release (label, pauseOnInteract, announce).
// An older copy ignores them; once the installed one declares them, drop the cast.
const STACK_PROPS = { label: "Background operations", pauseOnInteract: true, announce: true } as object;

export function ActivityTray() {
	const { operations, cancel, retry, dismiss, hideHere } = useOperations();
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
	const box = useRef<HTMLDivElement>(null);
	const hadFocus = useRef(false);

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

	// When the last row goes away while focus was inside the tray, put focus somewhere deliberate
	// (the page's main region) instead of letting it fall to the document.
	useEffect(() => {
		const el = box.current;
		if (items.length > 0) {
			hadFocus.current = !!el && el.contains(document.activeElement);
			return;
		}
		if (hadFocus.current) {
			hadFocus.current = false;
			const main = document.querySelector<HTMLElement>("main");
			if (main) {
				if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
				main.focus({ preventScroll: true });
			}
		}
	}, [items.length]);

	// Track focus while rows exist, so the effect above knows whether it was inside.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const sync = () => {
			hadFocus.current = el.contains(document.activeElement);
		};
		el.addEventListener("focusin", sync);
		el.addEventListener("focusout", sync);
		return () => {
			el.removeEventListener("focusin", sync);
			el.removeEventListener("focusout", sync);
		};
	}, [items.length > 0]);

	if (items.length === 0) return null;
	return (
		// Top right, under the 2.75rem (h-11) header; toasts stay bottom right, so they never meet.
		<div ref={box} className="fixed top-[3.25rem] right-4 z-50 w-80" data-testid="activity-tray">
			<ActivityStack items={items} {...STACK_PROPS} />
		</div>
	);
}
