import { useEffect, useRef } from "react";
import { useSSE, type SSEEventType } from "@/ui/contexts/SSEContext";

/** The slowest a visible, idle page asks the daemon for status; real changes arrive by SSE. */
export const VISIBLE_POLL_MS = 15_000;

/**
 * Runs `fn` at once, then every `intervalMs` while the document is visible. A hidden document polls
 * nothing; becoming visible again runs `fn` at once. An SSE event named in `events` also runs it,
 * so a real change shows within moments without a fast poll.
 *
 * Two invariants callers rely on:
 * - It fetches at mount. The server sends SSE events only to tabs that are connected, so an event
 *   that fired while no tab was open (or while this page was not mounted) is gone; the page must
 *   not wait for one to learn the current state.
 * - A server that runs in the foreground (not behind the runtime daemon) sends no status events
 *   for some changes, so what the page shows can be up to `intervalMs` (15 s) stale. That is
 *   accepted; a control that needs an exact answer must fetch on demand.
 */
export function useVisiblePolling(
	fn: () => void | Promise<void>,
	events: SSEEventType[] = [],
	intervalMs: number = VISIBLE_POLL_MS,
) {
	const fnRef = useRef(fn);
	fnRef.current = fn;
	const { subscribe } = useSSE();
	const eventsKey = events.join("|");

	useEffect(() => {
		let timer: number | undefined;
		const run = () => void fnRef.current();
		const start = () => {
			if (timer !== undefined) return;
			run();
			timer = window.setInterval(run, intervalMs);
		};
		const stop = () => {
			if (timer === undefined) return;
			window.clearInterval(timer);
			timer = undefined;
		};
		const onVisibility = () => (document.hidden ? stop() : start());
		if (!document.hidden) start();
		document.addEventListener("visibilitychange", onVisibility);
		const unsubs = eventsKey
			? (eventsKey.split("|") as SSEEventType[]).map((e) =>
					subscribe(e, () => {
						if (!document.hidden) run();
					}),
				)
			: [];
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
			for (const u of unsubs) u();
		};
	}, [subscribe, intervalMs, eventsKey]);
}
