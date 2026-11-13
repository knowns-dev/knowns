import type { AuditEvent } from "@/ui/api/client";
import type { Actor, Span } from "@/ui/lib/knowns/types";
import { errorSummary, toolLabel } from "./auditFormat";

/**
 * A pause longer than this between one call ending and the next one starting ends a session. An agent turn is a burst
 * of calls close together; a minute of silence means the agent stopped or the person took over.
 */
export const SESSION_GAP_MS = 60_000;

export interface AuditSession {
	/** Start of the first call: stable for the same calls, so it can key a view. */
	id: string;
	/** The agent, or null when the calls came from a client that is not a known agent. */
	client: string | null;
	start: number;
	end: number;
	/** Oldest first. */
	events: AuditEvent[];
}

const startOf = (event: AuditEvent) => Date.parse(event.timestamp);
const endOf = (event: AuditEvent) => startOf(event) + Math.max(0, event.durationMs || 0);

/**
 * Groups calls into sessions: consecutive calls of the same client, each starting within the gap of the previous
 * call's end. Calls that carry no client share one "unknown client" bucket. Events with a bad timestamp are skipped.
 * The result is oldest first.
 */
export function sessionize(events: AuditEvent[], gapMs = SESSION_GAP_MS): AuditSession[] {
	const sorted = events
		.filter((event) => Number.isFinite(startOf(event)))
		.sort((a, b) => startOf(a) - startOf(b));
	const sessions: AuditSession[] = [];
	let current: AuditSession | null = null;
	let currentEnd = 0;
	for (const event of sorted) {
		const client = event.client ?? null;
		const begin = startOf(event);
		if (!current || current.client !== client || begin - currentEnd > gapMs) {
			current = { id: event.timestamp, client, start: begin, end: endOf(event), events: [] };
			currentEnd = current.end;
			sessions.push(current);
		}
		current.events.push(event);
		currentEnd = Math.max(currentEnd, endOf(event));
		current.end = currentEnd;
	}
	return sessions;
}

/** The same recorded call, read twice (two fetches give two objects). */
export const sameCall = (a: AuditEvent, b: AuditEvent) =>
	a.timestamp === b.timestamp && a.toolName === b.toolName && a.action === b.action && a.result === b.result;

/** The session a given call belongs to. */
export function sessionOf(sessions: AuditSession[], target: AuditEvent): AuditSession | undefined {
	return sessions.find((session) => session.events.includes(target)) ??
		sessions.find((session) =>
			session.events.some(
				(event) => event.timestamp === target.timestamp && event.toolName === target.toolName && event.action === target.action,
			),
		);
}

export const needsAttention = (event: AuditEvent) => event.result === "error" || event.result === "denied";

/** The label for the agent in a session, "Unknown client" when the calls did not say. */
export const clientLabel = (client: string | null) => (client ? client : "Unknown client");

/**
 * The session as trace-waterfall input: the client is the agent, each tool is an actor it calls, each call is a span.
 * Errors and denials are failures, and the summary starts with the word so the result is told apart by text.
 */
export function toTrace(session: AuditSession): { actors: Actor[]; spans: Span[] } {
	const agentId = "client";
	const actors: Actor[] = [{ id: agentId, type: "agent", label: clientLabel(session.client), root: true }];
	const seen = new Set<string>();
	const spans: Span[] = session.events.map((event, index) => {
		const toolId = `tool:${event.toolName}`;
		if (!seen.has(toolId)) {
			seen.add(toolId);
			actors.push({ id: toolId, type: "tool", label: event.toolName });
		}
		const label = toolLabel(event);
		const start = startOf(event);
		const failed = needsAttention(event);
		const prefix = event.result === "denied" ? "Denied: " : event.result === "error" ? "Error: " : "";
		const reason = failed ? errorSummary(event) : "";
		return {
			id: `${event.timestamp}#${index}`,
			from: agentId,
			to: toolId,
			startedAt: start,
			endedAt: start + Math.max(1, event.durationMs || 0),
			outcome: failed ? "failure" : "success",
			summary: `${prefix}${label}${reason ? `: ${reason}` : ""}`,
			input: event.argumentSummary,
			error: failed ? reason || event.result : undefined,
		};
	});
	return { actors, spans };
}
