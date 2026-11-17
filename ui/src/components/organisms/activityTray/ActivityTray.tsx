/**
 * The Activity Tray: every running, queued or failed operation of this server and its daemon, as the
 * Knowns UI Pro Activity Stack. It lives in the header bar next to the notifications bell (spec FR-1,
 * revised 2026-11-17): an indicator that is there only while something is in the stack, and the stack
 * itself as a popover under it, so nothing ever floats over page content. The rules for what each row
 * shows and which buttons it has live in toActivityItem.tsx; the state is OperationsContext.
 */

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import { useOperations } from "../../../contexts/OperationsContext";
import { useSSEEvent } from "../../../contexts/SSEContext";
import { ActivityStack } from "../../ui/knowns/blocks/agents/activity-stack";
import { Spinner } from "../../ui/knowns/spinner";
import { toast } from "../../ui/sonner";
import { toActivityItem, type PendingAction } from "./toActivityItem";

/** How long the popover stays open on its own when something starts or fails. */
export const AUTO_OPEN_MS = 4000;

const reducedMotion = () =>
	typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ActivityTray() {
	const { operations, cancel, retry, dismiss, hideHere } = useOperations();
	const [pending, setPending] = useState<ReadonlyMap<string, PendingAction>>(() => new Map());
	const [open, setOpenState] = useState(false);
	// The same value in a ref: the auto-open timer and the events read it outside a render.
	const openRef = useRef(false);
	const setOpen = useCallback((next: boolean | ((was: boolean) => boolean)) => {
		const value = typeof next === "function" ? next(openRef.current) : next;
		openRef.current = value;
		setOpenState(value);
	}, []);
	const wrap = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const autoOpened = useRef(false);
	const failedSeen = useRef(new Set<string>());

	// One request at a time per row: the button is disabled while it is in flight.
	const run = useCallback((id: string, action: PendingAction, fn: () => Promise<void>) => {
		setPending((p) => new Map(p).set(id, action));
		fn()
			.catch((error) => toast.error(error instanceof Error ? error.message : "That did not work"))
			.finally(() =>
				setPending((p) => {
					const next = new Map(p);
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
					cancel: (id) => run(id, "cancel", () => cancel(id)),
					retry: (id) => run(id, "retry", () => retry(id)),
					dismissOnServer: (id) => run(id, "dismiss", () => dismiss(id)),
					hideHere,
				}),
			),
		[operations, pending, run, cancel, retry, dismiss, hideHere],
	);

	const failed = operations.filter((o) => o.state === "failed" || (o.state === "cancelled" && o.retryable)).length;
	const running = operations.filter((o) => o.state === "running" || o.state === "queued" || o.state === "cancelling").length;
	const count = operations.length;
	const label = `${count} background operation${count === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`;

	const clearAuto = useCallback(() => {
		clearTimeout(autoTimer.current);
		autoTimer.current = undefined;
	}, []);

	// The person took over (hover, focus, a click): the auto-open no longer closes by itself.
	const interact = useCallback(() => {
		autoOpened.current = false;
		clearAuto();
	}, [clearAuto]);

	const close = useCallback(
		(returnFocus: boolean) => {
			interact();
			setOpen(false);
			if (returnFocus) trigger.current?.focus();
		},
		[interact, setOpen],
	);

	// A NEW operation, or one that fails, opens the popover for a few seconds. Only live events do:
	// a reload or a reconnect brings a snapshot, which is not an event and never opens anything.
	const peek = useCallback(() => {
		if (reducedMotion()) return; // the indicator carries the state; nothing opens or moves
		// Already open (the person has it open, or an earlier peek): leave it alone.
		if (openRef.current) return;
		autoOpened.current = true;
		setOpen(true);
		clearAuto();
		autoTimer.current = setTimeout(() => {
			if (autoOpened.current) {
				autoOpened.current = false;
				setOpen(false);
			}
		}, AUTO_OPEN_MS);
	}, [clearAuto, setOpen]);

	useSSEEvent("operation:started", () => peek(), [peek]);
	const onChanged = useCallback(
		(e: { operation: { id: string; state: string } }) => {
			if (e.operation.state !== "failed") return;
			if (failedSeen.current.has(e.operation.id)) return;
			failedSeen.current.add(e.operation.id);
			peek();
		},
		[peek],
	);
	useSSEEvent("operation:updated", onChanged, [onChanged]);
	useSSEEvent("operation:finished", onChanged, [onChanged]);
	useEffect(() => () => clearTimeout(autoTimer.current), []);

	// The stack empties: the indicator goes, and so does the popover. Focus that was inside moves to
	// the page's main region instead of falling to the document.
	const hadFocus = useRef(false);
	useEffect(() => {
		const el = wrap.current;
		if (count > 0) {
			hadFocus.current = !!el && el.contains(document.activeElement);
			return;
		}
		setOpen(false);
		interact();
		if (hadFocus.current) {
			hadFocus.current = false;
			const main = document.querySelector<HTMLElement>("main");
			if (main) {
				if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
				main.focus({ preventScroll: true });
			}
		}
	}, [count, interact, setOpen]);

	useEffect(() => {
		const el = wrap.current;
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
	}, []);

	// Escape closes it and gives focus back to the indicator; a press outside closes it.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close(true);
			}
		};
		const onDown = (e: PointerEvent) => {
			if (wrap.current && !wrap.current.contains(e.target as Node)) close(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [open, close]);

	const tone = failed > 0 ? "text-destructive" : "text-foreground";

	return (
		// The stack stays mounted while the popover is closed (and while the stack is empty, hidden):
		// its live region must exist to announce, and a stack that mounts with its first row already
		// in it plays no entrance, so the first arrival is the one a person sees.
		<div ref={wrap} className="relative" hidden={count === 0} data-testid="activity-tray-root">
			<button
				ref={trigger}
				type="button"
				aria-label={label}
				aria-expanded={open}
				aria-haspopup="true"
				data-testid="activity-indicator"
				onClick={() => {
					interact();
					setOpen((o) => !o);
				}}
				onPointerEnter={() => autoOpened.current && interact()}
				className={cn(
					"inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 px-2.5 text-[12.5px] font-medium tabular-nums transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted active:scale-[0.97]",
					failed > 0 && "border-destructive/40",
					tone,
				)}
			>
				{running > 0 ? <Spinner label="" className="size-3.5" /> : failed > 0 ? <TriangleAlert aria-hidden className="size-3.5" /> : null}
				<span aria-hidden>{count}</span>
			</button>
			<div
				data-testid="activity-tray"
				data-open={open}
				onPointerEnter={interact}
				onFocusCapture={interact}
				className={cn(
					"absolute top-full right-0 z-50 mt-2 w-80 transition-[opacity,transform] duration-(--kn-dur) ease-(--kn-ease-out)",
					open
						? "translate-y-0 opacity-100"
						: // Closed: not visible and not reachable, but the stack's live region (a sibling of the
							// list) stays in the accessibility tree, so a state change is still announced.
							"pointer-events-none -translate-y-1 opacity-0 [&_button]:invisible [&_ul]:invisible",
				)}
			>
				<ActivityStack items={items} label="Background operations" pauseOnInteract announce />
			</div>
		</div>
	);
}
