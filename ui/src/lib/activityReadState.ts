import { useSyncExternalStore } from "react";

/**
 * Which activities have been read, kept in this browser only (the server has no read state).
 * An activity is unread when it is newer than the baseline and not in the read set. The baseline starts
 * at the old bell's "last checked" time, or now, so the first load never floods the bell.
 */
const READ_KEY = "knowns-activity-read-v1";
const BASELINE_KEY = "knowns-activity-baseline-v1";
const LEGACY_KEY = "knowns-last-activity-check";
const MAX_READ = 500;

interface Snapshot {
	baseline: number;
	read: ReadonlySet<string>;
}

const listeners = new Set<() => void>();
let snapshot: Snapshot | null = null;

function load(): Snapshot {
	let baseline = Number.NaN;
	let read: string[] = [];
	try {
		baseline = Number(localStorage.getItem(BASELINE_KEY));
		if (!Number.isFinite(baseline) || baseline <= 0) {
			const legacy = Date.parse(localStorage.getItem(LEGACY_KEY) ?? "");
			baseline = Number.isFinite(legacy) ? legacy : Date.now();
			localStorage.setItem(BASELINE_KEY, String(baseline));
		}
		const parsed = JSON.parse(localStorage.getItem(READ_KEY) ?? "[]");
		if (Array.isArray(parsed)) read = parsed.filter((v): v is string => typeof v === "string");
	} catch {
		// Storage unavailable: everything older than now counts as read, nothing persists.
		if (!Number.isFinite(baseline) || baseline <= 0) baseline = Date.now();
	}
	return { baseline, read: new Set(read) };
}

function current(): Snapshot {
	if (!snapshot) snapshot = load();
	return snapshot;
}

function commit(next: Snapshot) {
	snapshot = next;
	try {
		localStorage.setItem(READ_KEY, JSON.stringify([...next.read].slice(-MAX_READ)));
	} catch {
		// Not persisted; the session still behaves.
	}
	for (const listener of listeners) listener();
}

export function isUnread(state: Snapshot, id: string, at: number): boolean {
	return at > state.baseline && !state.read.has(id);
}

export function markRead(ids: readonly string[]) {
	const state = current();
	if (ids.every((id) => state.read.has(id))) return;
	commit({ ...state, read: new Set([...state.read, ...ids]) });
}

export function markUnread(id: string) {
	const state = current();
	if (!state.read.has(id)) return;
	const read = new Set(state.read);
	read.delete(id);
	commit({ ...state, read });
}

export function useActivityReadState(): Snapshot {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		current,
		current,
	);
}

/** Test hook: forget the cached snapshot so the next read goes back to storage. */
export function resetActivityReadState() {
	snapshot = null;
}
