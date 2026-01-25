/**
 * Import System Models
 *
 * Types and interfaces for importing templates/docs from external sources.
 */

/**
 * Import source types
 */
export type ImportType = "git" | "npm" | "local" | "registry";

/**
 * Import configuration stored in .knowns/config.json
 */
export interface ImportConfig {
	/** Unique identifier for this import */
	name: string;
	/** Source URL, package name, or path */
	source: string;
	/** Source type */
	type: ImportType;
	/** Git branch/tag (git only) */
	ref?: string;
	/** npm version range (npm only) */
	version?: string;
	/** Glob patterns to include */
	include?: string[];
	/** Glob patterns to exclude */
	exclude?: string[];
	/** Auto-sync on `knowns sync` */
	autoSync?: boolean;
	/** Symlink instead of copy (local only) */
	link?: boolean;
}

/**
 * Import metadata stored in .knowns/imports/<name>/.import.json
 */
export interface ImportMetadata {
	/** Import name (matches config) */
	name: string;
	/** Original source */
	source: string;
	/** Source type */
	type: ImportType;
	/** When first imported */
	importedAt: string;
	/** When last synced */
	lastSync: string;
	/** Git branch/tag used */
	ref?: string;
	/** Git commit hash */
	commit?: string;
	/** npm version installed */
	version?: string;
	/** List of imported files (relative paths) */
	files: string[];
	/** File hashes for conflict detection */
	fileHashes?: Record<string, string>;
}

/**
 * Import operation options
 */
export interface ImportOptions {
	/** Custom name (overrides auto-detected) */
	name?: string;
	/** Force source type detection */
	type?: ImportType;
	/** Git ref (branch/tag) */
	ref?: string;
	/** Include patterns */
	include?: string[];
	/** Exclude patterns */
	exclude?: string[];
	/** Symlink instead of copy (local only) */
	link?: boolean;
	/** Overwrite existing files */
	force?: boolean;
	/** Don't save to config */
	noSave?: boolean;
	/** Dry run - preview only */
	dryRun?: boolean;
	/** Internal: This is a sync operation, bypass "already exists" check */
	isSync?: boolean;
}

/**
 * Sync operation options
 */
export interface SyncOptions {
	/** Overwrite local changes */
	force?: boolean;
	/** Remove files deleted from source */
	prune?: boolean;
	/** Dry run - preview only */
	dryRun?: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
	/** Whether source is valid */
	valid: boolean;
	/** Error message if invalid */
	error?: string;
	/** Hint for fixing the error */
	hint?: string;
	/** Detected source type */
	type?: ImportType;
	/** Available content in .knowns/ */
	content?: {
		hasTemplates: boolean;
		hasDocs: boolean;
		templateCount?: number;
		docCount?: number;
	};
}

/**
 * File change during import/sync
 */
export interface FileChange {
	/** Relative file path */
	path: string;
	/** Type of change */
	action: "add" | "update" | "delete" | "skip";
	/** Reason for skip */
	skipReason?: string;
}

/**
 * Import/sync operation result
 */
export interface ImportResult {
	/** Whether operation succeeded */
	success: boolean;
	/** Import name */
	name: string;
	/** Source used */
	source: string;
	/** Source type */
	type: ImportType;
	/** Files changed */
	changes: FileChange[];
	/** Error message if failed */
	error?: string;
	/** Additional info */
	metadata?: ImportMetadata;
}

/**
 * Import error codes
 */
export enum ImportErrorCode {
	SOURCE_NOT_FOUND = "SOURCE_NOT_FOUND",
	NO_KNOWNS_DIR = "NO_KNOWNS_DIR",
	EMPTY_IMPORT = "EMPTY_IMPORT",
	NAME_CONFLICT = "NAME_CONFLICT",
	NETWORK_ERROR = "NETWORK_ERROR",
	AUTH_REQUIRED = "AUTH_REQUIRED",
	GIT_ERROR = "GIT_ERROR",
	NPM_ERROR = "NPM_ERROR",
	INVALID_SOURCE = "INVALID_SOURCE",
	SYNC_CONFLICT = "SYNC_CONFLICT",
}

/**
 * Import error with code and hint
 */
export class ImportError extends Error {
	constructor(
		message: string,
		public code: ImportErrorCode,
		public hint?: string,
	) {
		super(message);
		this.name = "ImportError";
	}
}
