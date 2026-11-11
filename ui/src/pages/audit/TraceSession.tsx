import { useEffect, useMemo, useState } from "react";
import { auditApi, type AuditEvent } from "@/ui/api/client";
import { Dialog } from "@/ui/components/ui/knowns/dialog";
import { Spinner } from "@/ui/components/ui/knowns/spinner";
import { TraceWaterfall } from "@/ui/components/ui/knowns/trace-waterfall/trace-waterfall";
import { browserTimezone, exactTime, formatDuration } from "./auditFormat";
import { clientLabel, needsAttention, SESSION_GAP_MS, sameCall, sessionize, sessionOf, toTrace } from "./sessions";

const DAY_LIMIT = 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The calendar day (YYYY-MM-DD) of a time in the browser's time zone, the way the audit range filter reads it. */
const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: browserTimezone() }).format(new Date(ms));

/**
 * One agent session as a trace waterfall: the calls around the chosen one, grouped by client with a pause of
 * SESSION_GAP_MS ending a session. The whole day is read without the list's filters so the session is complete.
 */
export function TraceSessionDialog({
	event,
	loaded,
	onClose,
}: {
	event: AuditEvent | null;
	/** The events the list already holds; used when the day cannot be read. */
	loaded: AuditEvent[];
	onClose: () => void;
}) {
	const [day, setDay] = useState<AuditEvent[] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!event) return;
		let cancelled = false;
		setDay(null);
		setFailed(false);
		const date = dayOf(Date.parse(event.timestamp));
		auditApi
			.recent({ limit: DAY_LIMIT, from: date, to: date, timezone: browserTimezone() })
			.then((data) => {
				if (!cancelled) setDay(data.events);
			})
			.catch(() => {
				if (cancelled) return;
				setFailed(true);
				setDay(loaded);
			});
		return () => {
			cancelled = true;
		};
	}, [event, loaded]);

	const session = useMemo(() => {
		if (!event || !day) return undefined;
		const all = day.some((other) => sameCall(other, event)) ? day : [...day, event];
		return sessionOf(sessionize(all), event);
	}, [event, day]);
	const trace = useMemo(() => (session ? toTrace(session) : null), [session]);
	const attention = session ? session.events.filter(needsAttention).length : 0;

	return (
		<Dialog
			open={event !== null}
			onOpenChange={(open) => !open && onClose()}
			title="Agent session"
			description={
				session
					? `${clientLabel(session.client)}, started ${exactTime(session.start)}`
					: "Calls made by the same client, with no pause longer than a minute."
			}
			size="lg"
			sheet
			className="sm:max-w-4xl open:flex max-h-[calc(100dvh-2rem)] flex-col"
			bodyClassName="min-h-0 flex-1 overflow-y-auto px-5 py-3"
		>
			{!session || !trace ? (
				<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
					<Spinner /> Loading the session
				</div>
			) : (
				<div className="flex flex-col gap-3" data-testid="audit-session">
					<p className="text-[13px] text-muted-foreground" data-testid="audit-session-summary">
						{plural(session.events.length, "call", "calls")} over {formatDuration(session.end - session.start)}
						{attention > 0 ? `, ${attention} need attention` : ", none need attention"}
					</p>
					<TraceWaterfall title="Calls in this session" actors={trace.actors} spans={trace.spans} maxHeight={420} />
					<p className="text-xs text-muted-foreground">
						A session is a run of calls from one client with no pause longer than {SESSION_GAP_MS / 1000} seconds.
						{failed ? " The rest of the day could not be loaded, so this shows only the calls already on the page." : ""}
					</p>
				</div>
			)}
		</Dialog>
	);
}
