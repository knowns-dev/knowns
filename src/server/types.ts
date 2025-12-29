/**
 * Shared types for server routes
 */

import type { FileStore } from "@storage/file-store";

export interface RouteContext {
	store: FileStore;
	broadcast: (data: object) => void;
}

export interface DocResult {
	filename: string;
	path: string;
	folder: string;
	metadata: Record<string, unknown>;
	content: string;
}
