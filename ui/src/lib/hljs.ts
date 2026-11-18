import type { HLJSApi } from "highlight.js";

/**
 * highlight.js on demand. The "common" build (about 40 languages) is dynamically imported the first
 * time a code block needs a language the built-in tokenizer does not know, so it stays out of the
 * entry's preload. Text renders first; callers re-render when `loadHljs()` resolves.
 */
let api: HLJSApi | null = null;
let pending: Promise<HLJSApi> | null = null;

/** The highlighter if it has loaded, else null (never triggers a load). */
export function getHljs(): HLJSApi | null {
	return api;
}

export function loadHljs(): Promise<HLJSApi> {
	pending ??= import("highlight.js/lib/common").then((m) => {
		api = m.default;
		return api;
	});
	return pending;
}
