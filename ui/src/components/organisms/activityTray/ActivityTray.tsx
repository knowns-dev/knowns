/**
 * The Activity Tray container: every running, queued or just finished operation of this server and
 * its daemon, in the corner of the app. TEMPORARY renderer: a plain list, behind a flag. The target
 * renderer is the Knowns UI Pro Activity Stack with an "operation" kind; the rules live in
 * operationView.ts, so that swap only replaces the list below.
 *
 * Flag: dev builds, or localStorage "knowns.activityTray" = "1".
 */

import { Loader2, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "../../ui/sonner";
import { useOperations } from "../../../contexts/OperationsContext";
import { operationView, type OperationAction } from "./operationView";

export function activityTrayEnabled(): boolean {
	if (import.meta.env.DEV) return true;
	try {
		return localStorage.getItem("knowns.activityTray") === "1";
	} catch {
		return false;
	}
}

const TONE = {
	busy: "text-muted-foreground",
	done: "text-emerald-600 dark:text-emerald-400",
	failed: "text-red-600 dark:text-red-400",
	stopped: "text-muted-foreground",
} as const;

export function ActivityTray() {
	const { operations, cancel, retry, dismiss } = useOperations();
	const [pending, setPending] = useState<Record<string, true>>({});
	if (operations.length === 0) return null;

	const run = async (id: string, action: OperationAction) => {
		setPending((p) => ({ ...p, [id]: true }));
		try {
			if (action === "cancel") await cancel(id);
			else if (action === "retry") await retry(id);
			else await dismiss(id);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "That did not work");
		} finally {
			setPending((p) => {
				const { [id]: _done, ...rest } = p;
				return rest;
			});
		}
	};

	return (
		<ul aria-label="Activity" className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" data-testid="activity-tray">
			{operations.map((op) => {
				const v = operationView(op);
				const busy = pending[v.id] === true;
				return (
					<li key={v.id} className="rounded-lg border bg-card p-3 text-sm shadow-sm" data-testid={`activity-${v.id}`} data-state={op.state}>
						<div className="flex items-center gap-2">
							{v.tone === "busy" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
							<span className="min-w-0 flex-1 truncate font-medium">{v.title}</span>
							{v.count && <span className="tabular-nums text-xs text-muted-foreground">{v.count}</span>}
						</div>
						{v.fraction !== null && v.tone === "busy" && (
							<div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
								<div className="h-full w-full origin-left bg-primary" style={{ transform: `scaleX(${v.fraction})` }} />
							</div>
						)}
						{v.detail && <p className={`mt-1 line-clamp-3 text-xs ${TONE[v.tone]}`}>{v.detail}</p>}
						{op.state === "cancelling" && <p className="mt-1 text-xs text-muted-foreground">Stopping…</p>}
						{v.actions.length > 0 && (
							<div className="mt-2 flex justify-end gap-1">
								{v.actions.map((a) => (
									<button
										key={a}
										type="button"
										disabled={busy}
										onClick={() => void run(v.id, a)}
										className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:text-foreground active:scale-[0.97] disabled:opacity-50"
									>
										{a === "retry" && <RotateCcw className="size-3" aria-hidden />}
										{a === "dismiss" && <X className="size-3" aria-hidden />}
										{a === "cancel" ? "Cancel" : a === "retry" ? v.retryLabel : "Dismiss"}
									</button>
								))}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
