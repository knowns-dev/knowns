// Bridge from the sonner-style `toast` API the app calls to the Knowns UI toast.
// Callers keep `toast.success(msg, opts)` etc.; <Toaster /> mounts the Knowns UI
// ToastProvider and registers itself as the host that actually shows them.

import { useEffect, type ReactNode } from "react";
import { ToastProvider, useDismissToast, useToast, type ToastOptions, type ToastTone } from "@/ui/components/ui/knowns/toast";

export type ToastId = string | number;

export interface BridgeToastOptions {
	id?: ToastId;
	description?: ReactNode;
	/** ms before it hides; Infinity keeps it until dismissed. */
	duration?: number;
	action?: { label: string; onClick: () => void };
	// Sonner-only options still passed by some callers; the Knowns UI toast has its own placement and look.
	position?: string;
	className?: string;
	icon?: ReactNode;
}

export interface ToastHost {
	show: (t: ToastOptions) => number;
	dismiss: (hostId: number) => void;
}

// setTimeout overflows above 2^31-1 ms and would fire at once.
const MAX_DURATION = 2_147_483_647;

let host: ToastHost | null = null;
let seq = 0;
const pending: { id: ToastId; t: ToastOptions }[] = [];
const shown = new Map<ToastId, number>();

function show(id: ToastId, t: ToastOptions) {
	if (!host) {
		if (pending.length === 0) console.warn("[toast] shown before <Toaster /> mounted; queued until it does");
		pending.push({ id, t });
		return;
	}
	const hostId = host.show(t);
	shown.set(id, hostId);
	// Ids are unique per call, so the map only needs to remember the recent few.
	if (shown.size > 50) shown.delete(shown.keys().next().value as ToastId);
}

function create(tone: ToastTone, title: ReactNode, opts: BridgeToastOptions = {}): ToastId {
	const id = opts.id ?? `t${++seq}`;
	if (opts.id !== undefined) dismiss(opts.id);
	const duration = opts.duration === undefined ? undefined : Math.min(opts.duration, MAX_DURATION);
	show(id, { title, description: opts.description, tone, action: opts.action, duration });
	return id;
}

function dismiss(id?: ToastId) {
	if (id === undefined) {
		pending.length = 0;
		if (host) for (const hostId of shown.values()) host.dismiss(hostId);
		shown.clear();
		return;
	}
	const queued = pending.findIndex((p) => p.id === id);
	if (queued !== -1) pending.splice(queued, 1);
	const hostId = shown.get(id);
	if (hostId !== undefined) {
		host?.dismiss(hostId);
		shown.delete(id);
	}
}

/** Registers the host that shows toasts and flushes anything queued before it. Returns the unregister. */
export function registerToastHost(next: ToastHost): () => void {
	host = next;
	for (const p of pending.splice(0)) show(p.id, p.t);
	return () => {
		if (host === next) host = null;
		shown.clear();
	};
}

type ToastFn = ((message: ReactNode, opts?: BridgeToastOptions) => ToastId) & {
	success: (message: ReactNode, opts?: BridgeToastOptions) => ToastId;
	error: (message: ReactNode, opts?: BridgeToastOptions) => ToastId;
	warning: (message: ReactNode, opts?: BridgeToastOptions) => ToastId;
	info: (message: ReactNode, opts?: BridgeToastOptions) => ToastId;
	dismiss: (id?: ToastId) => void;
};

export const toast: ToastFn = Object.assign((message: ReactNode, opts?: BridgeToastOptions) => create("neutral", message, opts), {
	success: (message: ReactNode, opts?: BridgeToastOptions) => create("success", message, opts),
	error: (message: ReactNode, opts?: BridgeToastOptions) => create("danger", message, opts),
	warning: (message: ReactNode, opts?: BridgeToastOptions) => create("warning", message, opts),
	info: (message: ReactNode, opts?: BridgeToastOptions) => create("neutral", message, opts),
	dismiss,
});

function ToastBridgeHost() {
	const showToast = useToast();
	const dismissToast = useDismissToast();
	useEffect(() => registerToastHost({ show: showToast, dismiss: dismissToast }), [showToast, dismissToast]);
	return null;
}

/** Mount once near the app root; toasts render bottom right. */
export function Toaster() {
	return (
		<ToastProvider>
			<ToastBridgeHost />
		</ToastProvider>
	);
}
