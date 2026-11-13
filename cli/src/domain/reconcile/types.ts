// The public types of internal/storage/reconciler.go and lifecycle_reconciler.go.

export const LIFECYCLE_BATCH_DEFAULT_LIMIT = 512;
export const DEFAULT_LIFECYCLE_BATCH_LIMIT = LIFECYCLE_BATCH_DEFAULT_LIMIT;
/** ReconcileQuietWindow. */
export const RECONCILE_QUIET_WINDOW_MS = 3_000;
/** ReconcileFlushCeiling. */
export const RECONCILE_FLUSH_CEILING_MS = 30_000;

/** ReconcileHint: the small, content-free boundary passed from watchers. */
export interface ReconcileHint {
  path: string;
  previousPath?: string;
  event?: string;
  at?: Date;
  entityType?: string;
  entityId?: string;
  hash?: string;
}

/** ReconcileResult: safe for logs and CLI output; it contains no entity text. */
export interface ReconcileResult {
  entityType: string;
  entityId: string;
  path: string;
  hash: string;
  changed: boolean;
  revision: number;
  diagnostic: string;
  operation: string;
  batchId: string;
  previousPath: string;
  currentPath: string;
  baseHash: string;
  newHash: string;
  pending: boolean;
  /** Undefined is Go's zero time. */
  retryAt?: Date;
}

export function emptyResult(fields: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    entityType: "",
    entityId: "",
    path: "",
    hash: "",
    changed: false,
    revision: 0,
    diagnostic: "",
    operation: "",
    batchId: "",
    previousPath: "",
    currentPath: "",
    baseHash: "",
    newHash: "",
    pending: false,
    ...fields,
  };
}

/** manifestEntry: the project-local ownership record of one stable identity. */
export interface ManifestEntry {
  entityType: string;
  entityId: string;
  path: string;
  hash: string;
  revision?: number;
  headHash?: string;
}

export interface ReconcileManifest {
  schemaVersion: number;
  entries: Record<string, ManifestEntry>;
}

/** LifecycleBatch: one bounded, deterministic import/Git burst. */
export interface LifecycleBatch {
  id?: string;
  source?: string;
  limit?: number;
  hints?: ReconcileHint[];
  wait?: boolean;
  exactEntityType?: string;
  exactEntityId?: string;
  exactPath?: string;
}

/** LifecycleOptions: controls a lifecycle pass without weakening validation. */
export interface LifecycleOptions {
  source?: string;
  batchId?: string;
  limit?: number;
  observedPaths?: string[];
  wait?: boolean;
  exactEntityType?: string;
  exactEntityId?: string;
  exactPath?: string;
}

/** RestoreOptions: the expected-state proof for a tombstone restore. */
export interface RestoreOptions {
  path?: string;
  expectedBaseHash?: string;
  actor?: string;
  batchId?: string;
}

/** HardDeleteOptions: a stronger contract than a normal filesystem delete. */
export interface HardDeleteOptions {
  trusted: boolean;
  confirmed: boolean;
  reason: string;
  actor?: string;
  path?: string;
  expectedHash?: string;
}

/** LifecycleFailureHooks: a test-only fault-injection seam. */
export interface LifecycleFailureHooks {
  beforeCanonicalRemove?: (entityType: string, entityId: string, path: string) => void;
  beforeCanonicalRead?: (path: string) => void;
}

export type IndexIntent = (result: ReconcileResult) => void | Promise<void>;
