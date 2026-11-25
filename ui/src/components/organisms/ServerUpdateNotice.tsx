/**
 * After `knowns update` a new server takes over the old one's port, and an open tab's event stream
 * reconnects to it without a reload: the page would run the old bundle against the new server. On every
 * `connected` the page reads the event's `version` or else asks GET /api/version; when it differs from the version it loaded with, this
 * shows a small notice with a Reload button. It never blocks the page. A server without the
 * endpoint (an older one) answers 404 and the notice stays away.
 */

import { useRef, useState } from "react";
import { API_BASE, apiFetch } from "../../api/client";
import { useSSEEvent } from "../../contexts/SSEContext";

async function fetchServerVersion(): Promise<string | null> {
	try {
		const res = await apiFetch(`${API_BASE}/api/version`);
		if (!res.ok) return null;
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

export function ServerUpdateNotice() {
	const loadedWith = useRef<string | null>(null);
	const [newer, setNewer] = useState<string | null>(null);

	useSSEEvent("connected", (e) => {
		// A server that names its version in the event is believed; any other is asked.
		void (e.version ? Promise.resolve(e.version) : fetchServerVersion()).then((version) => {
			if (!version) return;
			if (loadedWith.current === null) loadedWith.current = version;
			else if (version !== loadedWith.current) setNewer(version);
		});
	});

	if (!newer) return null;
	return (
		<div
			role="status"
			data-testid="server-update-notice"
			className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-lg"
		>
			<span>Knowns was updated to v{newer.replace(/^v/, "")}.</span>
			<button
				type="button"
				onClick={() => window.location.reload()}
				className="cursor-pointer rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-[transform,opacity] duration-(--kn-dur-fast) ease-(--kn-ease-out) active:scale-[0.97]"
			>
				Reload
			</button>
		</div>
	);
}
