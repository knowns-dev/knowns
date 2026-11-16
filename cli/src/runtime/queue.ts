// Port of internal/runtimequeue: the shared runtime queue under ~/.knowns/runtime (jobs, leases,
// dead letters, the project registry, the status file and the daemon's pid), written in exactly the
// files and JSON shapes the Go 0.34.1 binary uses, so a TS process and a Go daemon can share one
// runtime directory. Queue operations are synchronous (like Go's), the daemon loop is async.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { effectiveRuntimeWatch } from "../models/config.ts";
import { spawnDetached } from "../platform/detached-spawn.ts";
import { goJson } from "../search/json.ts";
import { goClean } from "../search/qdrant/pointer.ts";
import { goTimeString } from "../search/time.ts";
import { VERSION } from "../version.ts";
import {
  checkRunner,
  claimRunner,
  findDaemon,
  isRegisteredPid,
  partitionLeases,
  registerDaemon,
  releaseRunner,
  unregisterDaemon,
} from "./daemon-registry.ts";

export type JobKind =
  | "index-task"
  | "index-doc"
  | "remove-task"
  | "remove-doc"
  | "index-memory"
  | "remove-memory"
  | "index-decision"
  | "remove-decision"
  | "semantic-search"
  | "index-all-files"
  | "index-file"
  | "remove-file"
  | "reindex-search"
  | "reconcile-knowledge"
  | "reconcile-qdrant";

/** The kinds this version can execute. A job of another kind (written by a newer version) is left
 * alone in the queue: not run, not counted as pending, never dead-lettered. */
const KNOWN_JOB_KINDS: ReadonlySet<string> = new Set<JobKind>([
  "index-task",
  "index-doc",
  "remove-task",
  "remove-doc",
  "index-memory",
  "remove-memory",
  "index-decision",
  "remove-decision",
  "semantic-search",
  "index-all-files",
  "index-file",
  "remove-file",
  "reindex-search",
  "reconcile-knowledge",
  "reconcile-qdrant",
]);

export const JOB_REINDEX: JobKind = "reindex-search";
export const JOB_QDRANT_RECONCILE: JobKind = "reconcile-qdrant";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 20_000;
const DEFAULT_WATCH_GRACE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_LOCK_STALE_AGE_MS = 10_000;
const MAX_RECENT_RESULTS = 50;
const DEAD_LETTER_TTL_MS = 7 * 24 * 3_600_000;
const MAX_DEAD_LETTERS_KEPT = 50;
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_BACKUPS = 3;
const QDRANT_RETRY_LIMIT = 8;

/** Content-free handoff from durable history to targeted indexing. */
export interface QdrantIntent {
  entityType: string;
  entityId: string;
  revision: number;
  operation: string;
  canonicalHash?: string;
  path?: string;
  previousPath?: string;
  batchId?: string;
  generation: number;
}

export interface JobDetails {
  phase?: string;
  processed?: number;
  total?: number;
  stats?: Record<string, number>;
  /** json.RawMessage: any JSON value. */
  result?: unknown;
}

export interface Job {
  id: string;
  key: string;
  kind: JobKind;
  target?: string;
  requestedAt: string;
  runAfter: string;
  startedAt?: string | null;
  attempts?: number;
  lastError?: string;
  phase?: string;
  processed?: number;
  total?: number;
  details?: JobDetails | null;
  intent?: QdrantIntent | null;
  deadLetter?: boolean;
}

export interface JobResult {
  jobId: string;
  key: string;
  kind: JobKind;
  target?: string;
  success: boolean;
  error?: string;
  completedAt: string;
  requestedAt: string;
  startedAt: string;
  attemptCount: number;
  details?: JobDetails | null;
  retryable?: boolean;
  deadLetter?: boolean;
}

export interface QueueState {
  jobs: Job[];
  recent?: JobResult[];
  updatedAt?: string;
}

export interface JobSnapshot {
  job?: Job;
  result?: JobResult;
  found: boolean;
  completed: boolean;
}

export interface Lease {
  id: string;
  clientKind: string;
  projectRoot: string;
  watch: boolean;
  pid?: number;
  /** The version of the client that wrote the lease; the daemon of that version owns it. */
  version?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ProjectStatus {
  projectRoot: string;
  queuedJobs: number;
  runningJobs: number;
}

export interface WatcherStatus {
  projectRoot: string;
  demand: number;
  active: boolean;
  state: string;
  gracePending?: boolean;
  graceUntil?: string;
}

export interface Status {
  running: boolean;
  pid?: number;
  version?: string;
  startedAt?: string | null;
  clients: Lease[];
  projects: ProjectStatus[];
  watchers?: WatcherStatus[];
}

export interface ReloadRequest {
  id: string;
  requestedAt: string;
  pid?: number;
}

export interface ReloadStatus {
  requestId?: string;
  generation?: number;
  requestedAt?: string;
  processedAt?: string;
  pid?: number;
  success: boolean;
  error?: string;
}

export type Env = Record<string, string | undefined>;

// --- time, sleep, logging -----------------------------------------------------------------------

/** time.Now().UTC() as Go marshals it. */
export function nowString(ms: number = Date.now()): string {
  return goTimeString(new Date(ms).toISOString());
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** log.Printf: `2006/01/02 15:04:05 msg` on stderr, local time. */
export function goLogf(message: string): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  process.stderr.write(
    `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${message}\n`,
  );
}

function parseMs(v: string | undefined): number {
  return v === undefined ? Number.NaN : Date.parse(v);
}

// --- hooks (seams the daemon calls) -------------------------------------------------------------

export type Executor = (storeRoot: string, job: Job) => Promise<void> | void;
export type WatcherFactory = (signal: AbortSignal, storeRoot: string) => Promise<void>;
export type ReloadHandler = (reload: ReloadStatus) => Promise<void> | void;

export interface DaemonOptions {
  executor: Executor;
  watcherFactory?: WatcherFactory;
  reloadHandler?: ReloadHandler;
  /** Services run for the daemon's lifetime and stop when the signal aborts. */
  services?: ((signal: AbortSignal) => Promise<void>)[];
  keepAlive?: () => boolean;
  /** In-memory and cheap: true while the daemon has live work of its own (open MCP sessions). It
   * is asked every tick, unlike keepAlive, so a session that just opened is never missed. */
  busy?: () => boolean;
}

// --- environment and paths ----------------------------------------------------------------------

export const ENV_RUNTIME_ROOT = "KNOWNS_RUNTIME_ROOT";

export function shouldBypassDaemon(env: Env = process.env): boolean {
  return env.KNOWNS_RUNTIME_INLINE === "1";
}

export function globalRoot(env: Env = process.env): string {
  if (env.HOME) return join(env.HOME, ".knowns");
  try {
    const h = homedir();
    if (h) return join(h, ".knowns");
  } catch {
    // fall through
  }
  return join(tmpdir(), ".knowns");
}

export function runtimeRoot(env: Env = process.env): string {
  const override = (env[ENV_RUNTIME_ROOT] ?? "").trim();
  return override !== "" ? override : join(globalRoot(env), "runtime");
}

export const pidFile = (env?: Env) => join(runtimeRoot(env), "knowns-runtime.pid");

/** sanitizeProjectKey: parent dir name + 31-multiplier rune hash. */
export function sanitizeProjectKey(storeRoot: string): string {
  const clean = goClean(storeRoot);
  const sep = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
  let base = basename(dirname(clean));
  if (base === "" || base === "." || base === sep) base = "default";
  let h = 0;
  for (const ch of clean) h = (Math.imul(h, 31) + (ch.codePointAt(0) as number)) >>> 0;
  return `${base}-${h.toString(16).padStart(8, "0")}`;
}

export const queuePath = (storeRoot: string) =>
  join(runtimeRoot(), "queues", `${sanitizeProjectKey(storeRoot)}.json`);
const leaseDir = () => join(runtimeRoot(), "leases");
const leasePath = (id: string) => join(leaseDir(), `${id}.json`);
const projectsRegistryPath = () => join(runtimeRoot(), "projects.json");
export const statusPath = () => join(runtimeRoot(), "status.json");
export const runtimeLogPath = () => join(globalRoot(), "logs", "runtime.log");
export const mcpLogPath = () => join(globalRoot(), "logs", "mcp.log");
const stopFlagPath = () => join(runtimeRoot(), "stop.flag");
const reloadRequestPath = () => join(runtimeRoot(), "reload-request.json");
const reloadStatusPath = () => join(runtimeRoot(), "reload-status.json");

function envDurationMs(key: string, defaultMs: number): number {
  const raw = process.env[key];
  if (raw !== undefined && raw !== "" && /^[+-]?\d+$/.test(raw.trim())) {
    const ms = Number(raw);
    return ms <= 0 ? 0 : ms;
  }
  return defaultMs;
}

const idleTimeoutMs = () =>
  envDurationMs("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
export const leaseTtlMs = () => envDurationMs("KNOWNS_RUNTIME_LEASE_TTL_MS", DEFAULT_LEASE_TTL_MS);
const watchGraceMs = () => envDurationMs("KNOWNS_RUNTIME_WATCH_GRACE_MS", DEFAULT_WATCH_GRACE_MS);

export function debounceMs(kind: JobKind): number {
  switch (kind) {
    case "semantic-search":
    case "remove-task":
    case "remove-doc":
    case "remove-memory":
    case "remove-file":
    case "index-all-files":
    case "reindex-search":
      return 0;
    case "index-file":
      return envDurationMs("KNOWNS_CODE_INDEX_DEBOUNCE_MS", 1000);
    default:
      return envDurationMs("KNOWNS_ENTITY_INDEX_DEBOUNCE_MS", 5000);
  }
}

// --- process helpers ----------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillDaemon(): void {
  const pid = readPID();
  if (pid === undefined) throw new Error("no runtime pid");
  process.kill(pid, "SIGKILL");
}

function readPID(): number | undefined {
  try {
    const text = readFileSync(pidFile(), "utf8").replace(/^\s+|\s+$/g, "");
    return /^[+-]?\d+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

export function isRunning(): boolean {
  const pid = readPID();
  return pid !== undefined && isProcessAlive(pid);
}

// --- JSON files ---------------------------------------------------------------------------------

function ts(v: string | null | undefined): string | undefined {
  return v === undefined || v === null || v === "" ? undefined : goTimeString(v);
}

function detailsJson(d: JobDetails | null | undefined): unknown {
  if (!d) return undefined;
  return {
    ...(d.phase ? { phase: d.phase } : {}),
    ...(d.processed ? { processed: d.processed } : {}),
    ...(d.total ? { total: d.total } : {}),
    ...(d.stats && Object.keys(d.stats).length > 0 ? { stats: sortedMap(d.stats) } : {}),
    ...(d.result !== undefined && d.result !== null ? { result: d.result } : {}),
  };
}

function sortedMap<T>(m: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(m).sort(byteCompare)) out[k] = m[k] as T;
  return out;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function intentJson(i: QdrantIntent): unknown {
  return {
    entityType: i.entityType,
    entityId: i.entityId,
    revision: i.revision,
    operation: i.operation,
    ...(i.canonicalHash ? { canonicalHash: i.canonicalHash } : {}),
    ...(i.path ? { path: i.path } : {}),
    ...(i.previousPath ? { previousPath: i.previousPath } : {}),
    ...(i.batchId ? { batchId: i.batchId } : {}),
    generation: i.generation,
  };
}

/** The wire form of a job, in Go's struct field order with omitempty applied. */
export function jobJson(j: Job): unknown {
  return {
    id: j.id,
    key: j.key,
    kind: j.kind,
    ...(j.target ? { target: j.target } : {}),
    requestedAt: goTimeString(j.requestedAt),
    runAfter: goTimeString(j.runAfter),
    ...(ts(j.startedAt) ? { startedAt: ts(j.startedAt) } : {}),
    ...(j.attempts ? { attempts: j.attempts } : {}),
    ...(j.lastError ? { lastError: j.lastError } : {}),
    ...(j.phase ? { phase: j.phase } : {}),
    ...(j.processed ? { processed: j.processed } : {}),
    ...(j.total ? { total: j.total } : {}),
    ...(j.details ? { details: detailsJson(j.details) } : {}),
    ...(j.intent ? { intent: intentJson(j.intent) } : {}),
    ...(j.deadLetter ? { deadLetter: true } : {}),
  };
}

export function resultJson(r: JobResult): unknown {
  return {
    jobId: r.jobId,
    key: r.key,
    kind: r.kind,
    ...(r.target ? { target: r.target } : {}),
    success: r.success,
    ...(r.error ? { error: r.error } : {}),
    completedAt: goTimeString(r.completedAt),
    requestedAt: goTimeString(r.requestedAt),
    startedAt: goTimeString(r.startedAt),
    attemptCount: r.attemptCount,
    ...(r.details ? { details: detailsJson(r.details) } : {}),
    ...(r.retryable ? { retryable: true } : {}),
    ...(r.deadLetter ? { deadLetter: true } : {}),
  };
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.tmp`;
  const body = `${goJson(value, { indent: 2 })}\n`;
  // Windows: a scanner or another handle can still hold the tmp from the previous write.
  retryWhileBusy(() => writeFileSync(tmp, body, { mode: 0o644 }));
  renameOverFile(tmp, path);
}

function readJSONFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- Windows busy files (TSR-5EEY7V, from contributor PR #157) ----------------------------------
// Readers such as loadQueue take no lock. On Windows a rename over a file another process has
// open fails until it closes it, and the rename that replaces a file briefly refuses new handles,
// so both sides retry a transient failure for a bounded time.

/** How long a rename or read waits out another handle on Windows, and the delay between tries. */
const WINDOWS_FILE_BUSY_TIMEOUT_MS = 2000;
const WINDOWS_FILE_BUSY_RETRY_DELAY_MS = 5;

/**
 * ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION, as libuv reports them
 * (EPERM, EBUSY; EACCES for some access-denied paths), and only on Windows.
 */
export function isWindowsFileBusy(err: unknown, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export function retryWhileBusy<T>(op: () => T): T {
  const deadline = Date.now() + WINDOWS_FILE_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      return op();
    } catch (err) {
      if (!isWindowsFileBusy(err) || Date.now() > deadline) throw err;
      sleepSync(WINDOWS_FILE_BUSY_RETRY_DELAY_MS);
    }
  }
}

export function renameOverFile(tmp: string, path: string): void {
  retryWhileBusy(() => renameSync(tmp, path));
}

/** readFileSync(path, "utf8") for a file writeJSON replaces. */
function readFileRetrying(path: string): string {
  return retryWhileBusy(() => readFileSync(path, "utf8"));
}

function readJSONRetrying(path: string): unknown {
  return JSON.parse(readFileRetrying(path));
}

// --- locking (O_EXCL lock files, like Go) -------------------------------------------------------

function acquireLock(path: string, timeoutMs: number): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o644 });
      return () => retryWhileBusy(() => rmSync(path, { force: true }));
    } catch (err) {
      // Windows reports EPERM, not EEXIST, when the lock file is delete-pending (its owner just
      // released it while another handle was still open): wait it out like an existing lock.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" && !isWindowsFileBusy(err)) throw err;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > DEFAULT_LOCK_STALE_AGE_MS) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      // vanished: retry
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${path}`);
    sleepSync(50);
  }
}

// --- queue file ---------------------------------------------------------------------------------

export function loadQueue(storeRoot: string): QueueState {
  let data: string;
  try {
    data = readFileRetrying(queuePath(storeRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], recent: [] };
    throw err;
  }
  const parsed = JSON.parse(data) as Partial<QueueState> | null;
  const state: QueueState = {
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
    recent: Array.isArray(parsed?.recent) ? parsed.recent : [],
  };
  if (parsed?.updatedAt) state.updatedAt = parsed.updatedAt;
  return state;
}

// The daemon polls every registered project. A queue file that has not changed since the last
// poll is not read or parsed again: one stat per project per tick. Callers must not mutate the
// returned state.
interface QueueScanEntry {
  sig: string;
  state: QueueState;
  /** Jobs that are not dead letters, earliest due first (ties: earliest requested, file order). */
  live: { job: Job; due: number }[];
}
const queueScanCache = new Map<string, QueueScanEntry>();
const EMPTY_ENTRY: QueueScanEntry = { sig: "", state: { jobs: [], recent: [] }, live: [] };

function loadQueueEntry(storeRoot: string): QueueScanEntry {
  const path = queuePath(storeRoot);
  let sig: string;
  try {
    const st = statSync(path);
    sig = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
  } catch (err) {
    queueScanCache.delete(path);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_ENTRY;
    throw err;
  }
  const hit = queueScanCache.get(path);
  if (hit && hit.sig === sig) return hit;
  const state = loadQueue(storeRoot);
  const live = state.jobs
    .filter((j) => !j.deadLetter && KNOWN_JOB_KINDS.has(j.kind))
    .map((job) => ({ job, due: parseMs(job.runAfter), req: parseMs(job.requestedAt) }))
    .sort((a, b) => a.due - b.due || a.req - b.req)
    .map(({ job, due }) => ({ job, due }));
  const entry: QueueScanEntry = { sig, state, live };
  queueScanCache.set(path, entry);
  return entry;
}

export function loadQueueCached(storeRoot: string): QueueState {
  return loadQueueEntry(storeRoot).state;
}

function stateJson(state: QueueState): unknown {
  return {
    jobs: state.jobs.map(jobJson),
    ...(state.recent && state.recent.length > 0 ? { recent: state.recent.map(resultJson) } : {}),
    updatedAt: goTimeString(state.updatedAt ?? nowString()),
  };
}

export function updateQueue(storeRoot: string, fn: (state: QueueState) => void): void {
  const unlock = acquireLock(`${queuePath(storeRoot)}.lock`, DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const state = loadQueue(storeRoot);
    fn(state);
    pruneDeadLetters(storeRoot, state, Date.now());
    state.updatedAt = nowString();
    writeJSON(queuePath(storeRoot), stateJson(state));
  } finally {
    unlock();
  }
}

function pruneDeadLetters(storeRoot: string, state: QueueState, now: number): void {
  const dead = state.jobs.filter((j) => j.deadLetter);
  if (dead.length === 0) return;
  let expired = 0;
  let fresh = dead.filter((j) => {
    if (now - parseMs(j.requestedAt) > DEAD_LETTER_TTL_MS) {
      expired++;
      return false;
    }
    return true;
  });
  // Stable sort, newest requestedAt first.
  fresh = fresh
    .map((j, i) => ({ j, i }))
    .sort((a, b) => parseMs(b.j.requestedAt) - parseMs(a.j.requestedAt) || a.i - b.i)
    .map((x) => x.j);
  let overflow = 0;
  if (fresh.length > MAX_DEAD_LETTERS_KEPT) {
    overflow = fresh.length - MAX_DEAD_LETTERS_KEPT;
    fresh = fresh.slice(0, MAX_DEAD_LETTERS_KEPT);
  }
  if (expired === 0 && overflow === 0) return;
  const keep = new Set(fresh.map((j) => j.id));
  state.jobs = state.jobs.filter((j) => !j.deadLetter || keep.has(j.id));
  goLogf(
    `[runtime] dropped ${expired + overflow} dead-letter jobs for ${storeRoot} (${expired} expired, ${overflow} over the ${MAX_DEAD_LETTERS_KEPT} cap)`,
  );
}

// --- project registry ---------------------------------------------------------------------------

let registryCache: { sig: string; projects: string[] } | undefined;

export function registeredProjects(): string[] {
  let sig = "";
  try {
    const st = statSync(projectsRegistryPath());
    sig = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
    if (registryCache && registryCache.sig === sig) return [...registryCache.projects];
  } catch {
    // fall through to the read, which reports ENOENT
  }
  let data: string;
  try {
    data = readFileRetrying(projectsRegistryPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const projects = JSON.parse(data) as unknown;
  const out: string[] = [];
  if (!Array.isArray(projects)) return out;
  for (const p of projects) if (typeof p === "string" && p !== "" && !out.includes(p)) out.push(p);
  if (sig !== "") registryCache = { sig, projects: out };
  return [...out];
}

function projectRootExists(storeRoot: string): boolean {
  if (!isAbsolute(storeRoot)) return false;
  try {
    return statSync(storeRoot).isDirectory();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function projectHasQueuedJobs(storeRoot: string): boolean {
  try {
    return loadQueue(storeRoot).jobs.length > 0;
  } catch {
    return true;
  }
}

// A missing root can be an unmounted drive or a share that comes back, so it is only unregistered
// after it has stayed missing for MISSING_PROJECT_GRACE_MS. When each root was first seen missing
// lives beside projects.json, in a file 0.34.x never reads (spec D10).
const missingProjectsPath = () => join(runtimeRoot(), "projects-missing.json");

function readMissingSince(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(missingProjectsPath(), "utf8")) as unknown;
    const out: Record<string, number> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Removes the queue file of an unregistered project. */
function removeProjectQueueFiles(storeRoot: string): void {
  const path = queuePath(storeRoot);
  for (const p of [path, `${path}.lock`, `${path}.tmp`]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best effort
    }
  }
  queueScanCache.delete(path);
}

/** Drops registered roots that have been missing past the grace period and hold no jobs. */
function pruneDeadProjects(projects: string[], keep: string, now: number = Date.now()): string[] {
  const missing = readMissingSince();
  let changed = false;
  const live: string[] = [];
  let dropped = 0;
  for (const p of projects) {
    if (p === keep || projectRootExists(p)) {
      if (p in missing) {
        delete missing[p];
        changed = true;
      }
      live.push(p);
      continue;
    }
    if (!(p in missing)) {
      missing[p] = now;
      changed = true;
    }
    if (now - (missing[p] as number) < MISSING_PROJECT_GRACE_MS || projectHasQueuedJobs(p)) {
      live.push(p);
      continue;
    }
    dropped++;
    delete missing[p];
    changed = true;
    removeProjectQueueFiles(p);
  }
  for (const p of Object.keys(missing)) {
    if (!projects.includes(p)) {
      delete missing[p];
      changed = true;
    }
  }
  if (changed) {
    try {
      writeJSON(missingProjectsPath(), missing);
    } catch {
      // advisory
    }
  }
  if (dropped > 0)
    goLogf(`[runtime] unregistered ${dropped} project roots missing for over 30 days`);
  return live;
}

/** True when the project root is unreachable right now (skipped by the daemon, not forgotten). */
function projectRootMissing(storeRoot: string): boolean {
  return !projectRootExists(storeRoot);
}

/**
 * Periodic daemon housekeeping: unregister roots missing past the grace period and delete queue
 * files that no registered project owns, hold no jobs, and have not changed for a week.
 */
export function pruneRuntimeFiles(now: number = Date.now()): void {
  const unlock = acquireLock(`${projectsRegistryPath()}.lock`, DEFAULT_LOCK_TIMEOUT_MS);
  let registered: string[];
  try {
    registered = registeredProjects();
    const live = pruneDeadProjects(registered, "", now);
    if (live.length !== registered.length) {
      live.sort(byteCompare);
      writeJSON(projectsRegistryPath(), live);
    }
    registered = live;
  } finally {
    unlock();
  }
  const owned = new Set(registered.map((p) => basename(queuePath(p))));
  const dir = dirname(queuePath("x"));
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || owned.has(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < ORPHAN_QUEUE_MIN_AGE_MS) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { jobs?: unknown[] } | null;
      if (Array.isArray(parsed?.jobs) && parsed.jobs.length > 0) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      // unreadable or racing: leave it
    }
  }
  if (removed > 0) goLogf(`[runtime] removed ${removed} orphan queue files`);
}

function registerProject(storeRoot: string): void {
  const unlock = acquireLock(`${projectsRegistryPath()}.lock`, DEFAULT_LOCK_TIMEOUT_MS);
  try {
    let projects = registeredProjects();
    projects = pruneDeadProjects(projects, storeRoot);
    if (!projects.includes(storeRoot)) projects.push(storeRoot);
    projects.sort(byteCompare);
    writeJSON(projectsRegistryPath(), projects);
  } finally {
    unlock();
  }
}

// --- daemon lifecycle (client side) -------------------------------------------------------------

function runningDaemonVersion(): string {
  try {
    const persisted = readJSONRetrying(statusPath()) as { version?: string };
    return persisted.version ?? "";
  } catch {
    return "";
  }
}

/** Writes the stop flag and waits for the daemon to exit. */
export function requestShutdown(timeoutMs: number): void {
  mkdirSync(runtimeRoot(), { recursive: true, mode: 0o755 });
  writeFileSync(stopFlagPath(), nowString().replace(/(\.\d+)?Z$/, "Z"), { mode: 0o644 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) {
      rmSync(stopFlagPath(), { force: true });
      return;
    }
    sleepSync(150);
  }
  throw new Error("timed out waiting for outdated runtime to stop");
}

export function shouldStop(): boolean {
  return existsSync(stopFlagPath());
}

export function requestReload(): ReloadRequest {
  mkdirSync(runtimeRoot(), { recursive: true, mode: 0o755 });
  const request: ReloadRequest = { id: randomUUID(), requestedAt: nowString(), pid: process.pid };
  writeJSON(reloadRequestPath(), {
    id: request.id,
    requestedAt: request.requestedAt,
    pid: request.pid,
  });
  return request;
}

export function loadReloadStatus(): ReloadStatus {
  return readJSONRetrying(reloadStatusPath()) as ReloadStatus;
}

export async function waitForReload(requestId: string, timeoutMs: number): Promise<ReloadStatus> {
  if (requestId === "") throw new Error("reload request id is required");
  const limit = timeoutMs <= 0 ? 10_000 : timeoutMs;
  const deadline = Date.now() + limit;
  for (;;) {
    try {
      const status = loadReloadStatus();
      if (status.requestId === requestId) {
        if (status.success) return status;
        throw Object.assign(new Error(status.error || "runtime reload failed"), { status });
      }
    } catch (err) {
      if ((err as { status?: ReloadStatus }).status) throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for runtime reload ${requestId}`);
    await sleep(100);
  }
}

function pendingReload(): ReloadRequest | undefined {
  let data: string;
  try {
    data = readFileRetrying(reloadRequestPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const request = JSON.parse(data) as Partial<ReloadRequest>;
  return {
    id: request.id || randomUUID(),
    requestedAt: request.requestedAt || nowString(),
    ...(request.pid ? { pid: request.pid } : {}),
  };
}

async function acknowledgeReload(
  request: ReloadRequest,
  handler: ReloadHandler | undefined,
): Promise<ReloadStatus> {
  let previous: ReloadStatus | undefined;
  try {
    previous = loadReloadStatus();
  } catch {
    previous = undefined;
  }
  const status: ReloadStatus = {
    requestId: request.id,
    generation: (previous?.generation ?? 0) + 1,
    requestedAt: request.requestedAt,
    processedAt: nowString(),
    pid: process.pid,
    success: true,
  };
  if (handler) {
    try {
      await handler(status);
    } catch (err) {
      status.success = false;
      status.error = (err as Error).message;
    }
  }
  writeJSON(reloadStatusPath(), {
    ...(status.requestId ? { requestId: status.requestId } : {}),
    ...(status.generation ? { generation: status.generation } : {}),
    requestedAt: status.requestedAt,
    processedAt: status.processedAt,
    ...(status.pid ? { pid: status.pid } : {}),
    success: status.success,
    ...(status.error ? { error: status.error } : {}),
  });
  rmSync(reloadRequestPath(), { force: true });
  if (!status.success) throw new Error(status.error);
  return status;
}

function openRuntimeLogFile(): number {
  const path = runtimeLogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  rotateLogFiles(path, DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_BACKUPS);
  return openSync(path, "a", 0o644);
}

function rotateLogFiles(path: string, maxBytes: number, backups: number): void {
  try {
    if (statSync(path).size < maxBytes) return;
  } catch {
    return;
  }
  rmSync(`${path}.${backups}`, { force: true });
  for (let i = backups - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      // missing
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // ignore
  }
}

/** The argv that re-runs this program with `__runtime run`: a compiled binary or `bun <script>`. */
let daemonCommandOverride: (() => { cmd: string; args: string[] }) | undefined;

/** Tests that run the CLI in-process point the daemon spawn at the real entry script. */
export function setDaemonCommand(fn: (() => { cmd: string; args: string[] }) | undefined): void {
  daemonCommandOverride = fn;
}

/**
 * Whether argv[1] is the embedded entry of a `bun build --compile` binary rather than a script on
 * disk. POSIX binaries report /$bunfs/root/...; Windows ones report B:/~BUN/root/... with forward
 * slashes (Bun 1.3.12), so a backslash-only check spawned `knowns.exe B:/~BUN/root/bin.js
 * __runtime run` and the daemon never started on Windows.
 */
export function isCompiledEntry(script: string): boolean {
  return script === "" || script.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script);
}

export function daemonCommand(): { cmd: string; args: string[] } {
  if (daemonCommandOverride) return daemonCommandOverride();
  const script = process.argv[1] ?? "";
  const compiled = isCompiledEntry(script);
  return compiled
    ? { cmd: process.execPath, args: ["__runtime", "run"] }
    : { cmd: process.execPath, args: [script, "__runtime", "run"] };
}

/**
 * The environment a daemon is started with. KNOWNS_MCP_PROXY=0 is a client-side opt-out (FR-9):
 * a client that opts out must still start a normal daemon, or every later proxy would find it
 * without an endpoint.
 */
export function daemonSpawnEnv(env: Env): Env {
  const { KNOWNS_MCP_PROXY: _drop, ...rest } = env;
  return rest;
}

/**
 * A daemon from before the version registry owns the pid file and knows nothing of runner.json, so
 * it would run jobs next to ours: stop it, as an outdated daemon always was.
 */
function retireUnregisteredDaemon(): void {
  const pid = readPID();
  if (pid === undefined || !isProcessAlive(pid) || isRegisteredPid(pid)) return;
  const v = runningDaemonVersion();
  try {
    requestShutdown(10_000);
  } catch (err) {
    try {
      forceKillDaemon();
    } catch {
      throw new Error(`stop outdated runtime (v${v}, want v${VERSION}): ${(err as Error).message}`);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isProcessAlive(pid)) sleepSync(100);
    if (isProcessAlive(pid)) {
      throw new Error(`stop outdated runtime (v${v}, want v${VERSION}): ${(err as Error).message}`);
    }
  }
}

/**
 * EnsureDaemon: start the shared runtime daemon of this version unless one runs (or inline mode
 * is on). Daemons are version scoped: another version's daemon is left alone, it keeps serving its
 * own sessions and exits after the last one (spec D3).
 */
export function ensureDaemon(): void {
  if (shouldBypassDaemon()) return;
  if (findDaemon(VERSION)) return;
  retireUnregisteredDaemon();
  mkdirSync(runtimeRoot(), { recursive: true, mode: 0o755 });
  let unlock: () => void;
  try {
    unlock = acquireLock(join(runtimeRoot(), "start.lock"), DEFAULT_LOCK_TIMEOUT_MS);
  } catch (err) {
    if (findDaemon(VERSION)) return;
    throw err;
  }
  try {
    if (findDaemon(VERSION)) return;
    const logFd = openRuntimeLogFile();
    try {
      const { cmd, args } = daemonCommand();
      spawnDetached(cmd, args, { logPath: runtimeLogPath(), env: daemonSpawnEnv(process.env) });
    } catch (err) {
      throw new Error(`start runtime: ${(err as Error).message}`);
    } finally {
      closeSync(logFd);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (findDaemon(VERSION)) return;
      sleepSync(100);
    }
    throw new Error("timed out waiting for runtime to start");
  } finally {
    unlock();
  }
}

// --- enqueue ------------------------------------------------------------------------------------

export function jobKey(kind: JobKind, target: string): string {
  return `${kind}::${target}`;
}

function prepareEnqueue(storeRoot: string): void {
  mkdirSync(dirname(queuePath(storeRoot)), { recursive: true, mode: 0o755 });
  registerProject(storeRoot);
  ensureDaemon();
}

function enqueue(storeRoot: string, kind: JobKind, target: string): Job {
  if (storeRoot === "") throw new Error("store root is required");
  prepareEnqueue(storeRoot);
  let queued: Job | undefined;
  updateQueue(storeRoot, (state) => {
    const now = Date.now();
    const key = jobKey(kind, target);
    for (const job of state.jobs) {
      if (job.key !== key) continue;
      job.requestedAt = nowString(now);
      job.runAfter = nowString(now + debounceMs(kind));
      job.startedAt = null;
      job.lastError = "";
      queued = { ...job };
      return;
    }
    const job: Job = {
      id: randomUUID(),
      key,
      kind,
      requestedAt: nowString(now),
      runAfter: nowString(now + debounceMs(kind)),
    };
    if (target !== "") job.target = target;
    state.jobs.push(job);
    queued = { ...job };
  });
  return queued as unknown as Job;
}

/** Enqueue: incremental background work. A full rebuild must use enqueueReindex. */
export function enqueueJob(storeRoot: string, kind: JobKind, target: string): Job {
  if (kind === JOB_REINDEX) throw new Error("full search reindex requires EnqueueReindex");
  return enqueue(storeRoot, kind, target);
}

export function enqueueReindex(storeRoot: string): Job {
  return enqueue(storeRoot, JOB_REINDEX, "");
}

export function qdrantIntentKey(intent: QdrantIntent): string {
  return `qdrant:${intent.entityType}:${intent.entityId}`;
}

function jobGeneration(job: Job | undefined): number {
  return job?.intent ? job.intent.generation : 0;
}

export function enqueueQdrantIntent(storeRoot: string, input: QdrantIntent): Job {
  if (storeRoot === "") throw new Error("store root is required");
  if (input.entityType.trim() === "" || input.entityId.trim() === "") {
    throw new Error("qdrant intent entity identity is required");
  }
  const intent = { ...input };
  if (!intent.generation) {
    intent.generation = intent.revision || 1;
  }
  prepareEnqueue(storeRoot);
  let queued: Job | undefined;
  updateQueue(storeRoot, (state) => {
    const now = Date.now();
    const key = qdrantIntentKey(intent);
    for (const job of state.jobs) {
      if (job.key !== key) continue;
      if (job.intent && job.intent.generation >= intent.generation) {
        queued = { ...job };
        return;
      }
      intent.generation = Math.max(intent.generation, jobGeneration(job) + 1);
      job.intent = { ...intent };
      job.requestedAt = nowString(now);
      job.runAfter = nowString(now + debounceMs(JOB_QDRANT_RECONCILE));
      job.lastError = "";
      job.deadLetter = false;
      if (job.startedAt === undefined || job.startedAt === null) job.attempts = 0;
      queued = { ...job };
      return;
    }
    const job: Job = {
      id: randomUUID(),
      key,
      kind: JOB_QDRANT_RECONCILE,
      target: `${intent.entityType}:${intent.entityId}`,
      requestedAt: nowString(now),
      runAfter: nowString(now + debounceMs(JOB_QDRANT_RECONCILE)),
      intent: { ...intent },
    };
    state.jobs.push(job);
    queued = { ...job };
  });
  return queued as unknown as Job;
}

export async function waitForJob(
  storeRoot: string,
  jobId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JobResult> {
  const limit = timeoutMs <= 0 ? 30_000 : timeoutMs;
  const deadline = Date.now() + limit;
  for (;;) {
    if (signal?.aborted) throw new Error("context canceled");
    try {
      const state = loadQueue(storeRoot);
      if (!state.jobs.some((j) => j.id === jobId)) {
        for (const r of state.recent ?? []) {
          if (r.jobId !== jobId) continue;
          if (r.success) return r;
          throw Object.assign(new Error(r.error ?? ""), { result: r });
        }
      }
    } catch (err) {
      if ((err as { result?: JobResult }).result) throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for runtime job ${jobId}`);
    await sleep(200, signal);
  }
}

/** How a progress-bounded wait ended: the job finished, or it stopped moving while still queued. */
export type JobWaitOutcome =
  | { status: "completed"; result: JobResult }
  | { status: "pending"; job: Job }
  | { status: "stopped"; job: Job };

/** How long the runtime daemon may be gone before a wait stops on it (a restart takes seconds). */
const DAEMON_GONE_GRACE_MS = 10_000;

/**
 * Wait for a job for as long as it makes progress. waitForJob gives up after a fixed time, which a
 * full reindex on a real knowledge base outlives: the CLI then reported a failure for a job the
 * daemon went on to finish (@task-KN-Q6DVKQ). This wait gives up only after `stallMs` without
 * movement: the job starting, changing phase or count, or, while it is still queued, the jobs
 * ahead of it finishing. A job still in the queue at that point comes back as "pending". If the
 * runtime daemon is gone (no live pid) for a short grace while the job is still queued, nothing
 * will run it, so the wait stops early with "stopped". A failed job throws as in waitForJob, and
 * a job that is in neither the queue nor the recent results times out with waitForJob's error.
 */
export async function waitForJobProgress(
  storeRoot: string,
  jobId: string,
  stallMs: number,
  signal?: AbortSignal,
): Promise<JobWaitOutcome> {
  const limit = stallMs <= 0 ? 30_000 : stallMs;
  const grace = Math.min(limit, DAEMON_GONE_GRACE_MS);
  let lastSignature = "";
  let lastMove = Date.now();
  let daemonGoneSince = 0;
  let pending: Job | undefined;
  for (;;) {
    if (signal?.aborted) throw new Error("context canceled");
    try {
      const state = loadQueue(storeRoot);
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) {
        pending = undefined;
        for (const r of state.recent ?? []) {
          if (r.jobId !== jobId) continue;
          if (r.success) return { status: "completed", result: r };
          throw Object.assign(new Error(r.error ?? ""), { result: r });
        }
      } else {
        pending = { ...job };
        const latest = state.recent?.[0];
        const signature = JSON.stringify([
          job.startedAt ?? null,
          job.attempts ?? 0,
          job.phase ?? "",
          job.processed ?? 0,
          job.total ?? 0,
          job.startedAt ? null : [state.jobs.length, latest?.jobId, latest?.completedAt],
        ]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastMove = Date.now();
        }
      }
    } catch (err) {
      if ((err as { result?: JobResult }).result) throw err;
    }
    if (pending && !isRunning()) {
      if (daemonGoneSince === 0) daemonGoneSince = Date.now();
      else if (Date.now() - daemonGoneSince > grace) return { status: "stopped", job: pending };
    } else {
      daemonGoneSince = 0;
    }
    if (Date.now() - lastMove > limit) {
      if (pending) return { status: daemonGoneSince ? "stopped" : "pending", job: pending };
      throw new Error(`timed out waiting for runtime job ${jobId}`);
    }
    await sleep(200, signal);
  }
}

export function loadJobSnapshot(storeRoot: string, jobId: string): JobSnapshot {
  const state = loadQueue(storeRoot);
  const job = state.jobs.find((j) => j.id === jobId);
  if (job) return { job: { ...job }, found: true, completed: false };
  const result = (state.recent ?? []).find((r) => r.jobId === jobId);
  if (result) return { result: { ...result }, found: true, completed: true };
  return { found: false, completed: false };
}

export function markJobStarted(storeRoot: string, jobId: string): Job {
  let started: Job | undefined;
  updateQueue(storeRoot, (state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    job.startedAt = nowString();
    job.attempts = (job.attempts ?? 0) + 1;
    started = { ...job };
  });
  return started as unknown as Job;
}

export function reportProgress(
  storeRoot: string,
  jobId: string,
  phase: string,
  processed: number,
  total: number,
): void {
  updateQueue(storeRoot, (state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (phase !== "") job.phase = phase;
    job.processed = processed;
    job.total = total;
  });
}

export function reportDetails(storeRoot: string, jobId: string, details: JobDetails): void {
  updateQueue(storeRoot, (state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.details = details;
  });
}

export function qdrantRetryDelayMs(attempt: number): number {
  const a = attempt < 1 ? 1 : attempt;
  const delay = 1000 * 2 ** Math.min(a - 1, 30);
  return Math.min(delay, 5 * 60_000);
}

export function completeJob(storeRoot: string, job: Job, err: Error | undefined): void {
  updateQueue(storeRoot, (state) => {
    let finalJob: Job = job;
    let queuedCurrent: Job | undefined;
    const jobs: Job[] = [];
    for (const queued of state.jobs) {
      if (queued.id !== job.id) {
        jobs.push(queued);
        continue;
      }
      queuedCurrent = queued;
      finalJob = { ...queued };
    }
    const hasSuccessor =
      queuedCurrent !== undefined &&
      job.intent &&
      queuedCurrent.intent &&
      queuedCurrent.intent.generation > job.intent.generation;
    if (queuedCurrent && hasSuccessor) {
      const copy: Job = { ...queuedCurrent };
      copy.startedAt = null;
      copy.attempts = 0;
      copy.lastError = "";
      copy.runAfter = nowString();
      jobs.push(copy);
    }
    state.jobs = jobs;
    const startedAt = finalJob.startedAt ? finalJob.startedAt : finalJob.requestedAt;
    const result: JobResult = {
      jobId: finalJob.id,
      key: finalJob.key,
      kind: finalJob.kind,
      success: err === undefined,
      completedAt: nowString(),
      requestedAt: finalJob.requestedAt,
      startedAt,
      attemptCount: finalJob.attempts ?? 0,
    };
    if (finalJob.target) result.target = finalJob.target;
    if (err) result.error = err.message;
    if (finalJob.kind === JOB_QDRANT_RECONCILE && err) {
      result.retryable = true;
      if ((finalJob.attempts ?? 0) >= QDRANT_RETRY_LIMIT) {
        result.deadLetter = true;
        result.retryable = false;
        const copy: Job = {
          ...finalJob,
          startedAt: null,
          lastError: err.message,
          deadLetter: true,
        };
        copy.runAfter = nowString(Date.now() + 24 * 3_600_000);
        jobs.push(copy);
        state.jobs = jobs;
      } else if (!hasSuccessor) {
        const copy: Job = { ...finalJob, startedAt: null, lastError: err.message };
        copy.runAfter = nowString(Date.now() + qdrantRetryDelayMs(finalJob.attempts ?? 0));
        jobs.push(copy);
        state.jobs = jobs;
      }
    }
    if (finalJob.details) result.details = finalJob.details;
    else if (finalJob.phase || (finalJob.processed ?? 0) > 0) {
      result.details = {
        ...(finalJob.phase ? { phase: finalJob.phase } : {}),
        ...(finalJob.processed ? { processed: finalJob.processed } : {}),
        ...(finalJob.total ? { total: finalJob.total } : {}),
      };
    }
    state.recent = [result, ...(state.recent ?? [])].slice(0, MAX_RECENT_RESULTS);
  });
}

// --- dead letters -------------------------------------------------------------------------------

export function isReleasableDeadLetter(job: Job): boolean {
  return job.kind === JOB_QDRANT_RECONCILE && job.deadLetter === true;
}

function releaseDeadLetter(job: Job, now: string): void {
  job.deadLetter = false;
  job.attempts = 0;
  job.lastError = "";
  job.runAfter = now;
}

export function retryJob(storeRoot: string, jobId: string): Job {
  let retried: Job | undefined;
  updateQueue(storeRoot, (state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (!isReleasableDeadLetter(job)) throw new Error(`job ${jobId} is not a qdrant dead letter`);
    releaseDeadLetter(job, nowString());
    retried = { ...job };
  });
  return retried as unknown as Job;
}

export function listDeadLetters(storeRoot: string): Job[] {
  return loadQueue(storeRoot)
    .jobs.filter(isReleasableDeadLetter)
    .map((j) => ({ ...j }));
}

export function retryDeadLetters(storeRoot: string): Job[] {
  const released: Job[] = [];
  updateQueue(storeRoot, (state) => {
    const now = nowString();
    for (const job of state.jobs) {
      if (!isReleasableDeadLetter(job)) continue;
      releaseDeadLetter(job, now);
      released.push({ ...job });
    }
  });
  return released;
}

// --- leases and status --------------------------------------------------------------------------

export class ClientHandle {
  private released = false;
  constructor(readonly lease: Lease) {}

  refresh(): void {
    if (this.released) return;
    const now = Date.now();
    this.lease.updatedAt = nowString(now);
    this.lease.expiresAt = nowString(now + leaseTtlMs());
    mkdirSync(leaseDir(), { recursive: true, mode: 0o755 });
    writeFileSync(leasePath(this.lease.id), `${goJson(leaseJson(this.lease), { indent: 2 })}\n`, {
      mode: 0o644,
    });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    rmSync(leasePath(this.lease.id), { force: true });
  }
}

export function leaseJson(l: Lease): unknown {
  return {
    id: l.id,
    clientKind: l.clientKind,
    projectRoot: l.projectRoot,
    watch: l.watch,
    ...(l.pid ? { pid: l.pid } : {}),
    ...(l.version ? { version: l.version } : {}),
    createdAt: goTimeString(l.createdAt),
    updatedAt: goTimeString(l.updatedAt),
    expiresAt: goTimeString(l.expiresAt),
  };
}

export function acquireClient(
  kind: string,
  projectRoot: string,
  watch: boolean,
  opts: { ensure?: boolean } = {},
): ClientHandle {
  if (projectRoot === "") throw new Error("project root is required");
  mkdirSync(leaseDir(), { recursive: true, mode: 0o755 });
  registerProject(projectRoot);
  if (opts.ensure !== false) ensureDaemon();
  const now = Date.now();
  const handle = new ClientHandle({
    id: randomUUID(),
    clientKind: kind,
    projectRoot,
    watch,
    pid: process.pid,
    version: VERSION,
    createdAt: nowString(now),
    updatedAt: nowString(now),
    expiresAt: nowString(now + leaseTtlMs()),
  });
  handle.refresh();
  return handle;
}

function parseBool(value: string, fallback: boolean): boolean {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function projectRuntimeWatch(projectRoot: string): ReturnType<typeof effectiveRuntimeWatch> {
  let settings: { runtimeWatch?: Record<string, unknown> } = {};
  if (projectRoot !== "") {
    try {
      const cfg = readJSONFile(join(projectRoot, "config.json")) as {
        settings?: { runtimeWatch?: Record<string, unknown> };
      };
      settings = cfg.settings ?? {};
    } catch {
      settings = {};
    }
  }
  return effectiveRuntimeWatch(settings as Parameters<typeof effectiveRuntimeWatch>[0]);
}

export function watchEnabledForClient(kind: string, projectRoot: string): boolean {
  const raw = process.env.KNOWNS_RUNTIME_WATCH_ENABLED;
  if (raw !== undefined && raw !== "") return parseBool(raw, true);
  const settings = projectRuntimeWatch(projectRoot);
  if (settings.enabled === false) return false;
  for (const eligible of settings.eligibleClients) {
    if (eligible.trim().toLowerCase() === kind.toLowerCase() || eligible.trim() === "*")
      return true;
  }
  return false;
}

export function acquireConfiguredClient(
  kind: string,
  projectRoot: string,
  opts: { ensure?: boolean } = {},
): ClientHandle {
  return acquireClient(kind, projectRoot, watchEnabledForClient(kind, projectRoot), opts);
}

export function startHeartbeat(signal: AbortSignal, handle: ClientHandle): void {
  // An already-aborted signal never fires its listener: release now instead of leaking the lease.
  if (signal.aborted) {
    handle.release();
    return;
  }
  const timer = setInterval(() => {
    try {
      handle.refresh();
    } catch {
      // ignore
    }
  }, leaseTtlMs() / 2);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      handle.release();
    },
    { once: true },
  );
}

const leaseScanCache = new Map<string, { sig: string; lease: Lease }>();

export function activeLeases(): Lease[] {
  mkdirSync(leaseDir(), { recursive: true, mode: 0o755 });
  const now = Date.now();
  const leases: Lease[] = [];
  for (const name of readdirSync(leaseDir())) {
    const path = join(leaseDir(), name);
    if (extname(name) !== ".json") continue;
    let lease: Lease;
    try {
      const st = statSync(path);
      if (st.isDirectory()) continue;
      // A heartbeat rewrites the file; between heartbeats the daemon reuses the parsed lease.
      const sig = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
      const hit = leaseScanCache.get(path);
      if (hit && hit.sig === sig) {
        lease = hit.lease;
      } else {
        lease = readJSONRetrying(path) as Lease;
        leaseScanCache.set(path, { sig, lease });
      }
    } catch {
      continue;
    }
    if (!(parseMs(lease.expiresAt) > now)) {
      rmSync(path, { force: true });
      continue;
    }
    if ((lease.pid ?? 0) > 0 && !isProcessAlive(lease.pid as number)) {
      rmSync(path, { force: true });
      continue;
    }
    leases.push(lease);
  }
  leases.sort((a, b) =>
    a.projectRoot === b.projectRoot
      ? byteCompare(a.id, b.id)
      : byteCompare(a.projectRoot, b.projectRoot),
  );
  return leases;
}

export function loadStatus(): Status {
  const status: Status = { running: false, clients: [], projects: [] };
  const pid = readPID();
  if (pid !== undefined) {
    status.running = isProcessAlive(pid);
    status.pid = pid;
  }
  try {
    const persisted = readJSONRetrying(statusPath()) as {
      version?: string;
      startedAt?: string | null;
      watchers?: WatcherStatus[];
    };
    if (persisted.version) status.version = persisted.version;
    if (persisted.startedAt) status.startedAt = persisted.startedAt;
    if (persisted.watchers) status.watchers = persisted.watchers;
  } catch {
    // no status file
  }
  try {
    status.clients = activeLeases();
  } catch {
    status.clients = [];
  }
  let projects: string[] = [];
  try {
    projects = registeredProjects();
  } catch {
    projects = [];
  }
  for (const projectRoot of projects) {
    let queue: QueueState;
    try {
      queue = loadQueue(projectRoot);
    } catch {
      continue;
    }
    let queued = 0;
    let running = 0;
    for (const job of queue.jobs) {
      if (job.startedAt !== undefined && job.startedAt !== null) running++;
      else queued++;
    }
    status.projects.push({ projectRoot, queuedJobs: queued, runningJobs: running });
  }
  return status;
}

/** json.Marshal of Status (what `__runtime status --json` prints). */
export function statusJson(s: Status): unknown {
  return {
    running: s.running,
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.version ? { version: s.version } : {}),
    ...(s.startedAt ? { startedAt: goTimeString(s.startedAt) } : {}),
    clients: s.clients.map(leaseJson),
    projects: s.projects,
    ...(s.watchers && s.watchers.length > 0 ? { watchers: s.watchers.map(watcherJson) } : {}),
  };
}

export function watcherJson(w: WatcherStatus): unknown {
  return {
    projectRoot: w.projectRoot,
    demand: w.demand,
    active: w.active,
    state: w.state,
    ...(w.gracePending ? { gracePending: true } : {}),
    // time.Time with omitempty is never omitted.
    graceUntil: goTimeString(w.graceUntil || "0001-01-01T00:00:00Z"),
  };
}

// --- watcher lifecycle --------------------------------------------------------------------------

type WatcherState = "running" | "grace" | "cancelRequested" | "stopped";

interface WatchEntry {
  abort: AbortController;
  graceUntil: number;
  state: WatcherState;
  done: boolean;
}

export function leaseRequestsWatch(lease: Lease, now: number): boolean {
  return (
    lease.watch && lease.projectRoot !== "" && (!lease.expiresAt || parseMs(lease.expiresAt) > now)
  );
}

function projectWatchGraceMs(projectRoot: string): number {
  const grace = watchGraceMs();
  if (projectRoot === "") return grace;
  let configured: string;
  try {
    const cfg = readJSONFile(join(projectRoot, "config.json")) as {
      settings?: { runtimeWatch?: { gracePeriod?: string } };
    };
    configured = effectiveRuntimeWatch(
      (cfg.settings ?? {}) as Parameters<typeof effectiveRuntimeWatch>[0],
    ).gracePeriod;
  } catch {
    return grace;
  }
  if (!configured) return grace;
  const parsed = parseGoDurationMs(configured);
  return parsed === undefined || parsed < 0 ? grace : parsed;
}

/** time.ParseDuration to milliseconds; undefined when invalid. */
export function parseGoDurationMs(text: string): number | undefined {
  const s = text.trim();
  if (s === "0") return 0;
  const re = /(\d+(?:\.\d+)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy;
  const unit: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    μs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const sign = s.startsWith("-") ? -1 : 1;
  const body = s.replace(/^[+-]/, "");
  if (body === "") return undefined;
  re.lastIndex = 0;
  let total = 0;
  let pos = 0;
  const bodyRe = new RegExp(re.source, "gy");
  for (;;) {
    if (pos === body.length) break;
    bodyRe.lastIndex = pos;
    const m = bodyRe.exec(body);
    if (!m) return undefined;
    total += Number(m[1]) * (unit[m[2] as string] as number);
    pos = bodyRe.lastIndex;
  }
  return sign * total;
}

export class WatchLifecycle {
  private watchers = new Map<string, WatchEntry>();

  constructor(
    private now: () => number = Date.now,
    private gracePeriod: (root: string) => number = projectWatchGraceMs,
  ) {}

  reconcile(leases: Lease[], factory: WatcherFactory | undefined): void {
    const now = this.now();
    const demand = new Map<string, number>();
    for (const lease of leases) {
      if (leaseRequestsWatch(lease, now)) {
        demand.set(lease.projectRoot, (demand.get(lease.projectRoot) ?? 0) + 1);
      }
    }
    for (const [projectRoot, entry] of [...this.watchers]) {
      if (entry.done) this.watchers.delete(projectRoot);
      if ((demand.get(projectRoot) ?? 0) > 0) {
        if (entry.state === "grace") {
          entry.graceUntil = 0;
          entry.state = "running";
        }
        continue;
      }
      if (entry.done) continue;
      if (entry.state === "cancelRequested") continue;
      if (entry.state === "running") {
        let grace = this.gracePeriod(projectRoot);
        if (grace < 0) grace = DEFAULT_WATCH_GRACE_MS;
        entry.graceUntil = now + grace;
        entry.state = "grace";
      }
      if (now >= entry.graceUntil) {
        entry.abort.abort();
        entry.state = "cancelRequested";
      }
    }
    if (!factory) return;
    for (const [projectRoot, count] of demand) {
      if (count === 0 || this.watchers.has(projectRoot)) continue;
      const abort = new AbortController();
      const entry: WatchEntry = { abort, graceUntil: 0, state: "running", done: false };
      this.watchers.set(projectRoot, entry);
      factory(abort.signal, projectRoot)
        .catch((err) => {
          if (!abort.signal.aborted)
            goLogf(`[runtime] watcher failed for ${projectRoot}: ${(err as Error).message}`);
        })
        .finally(() => {
          entry.done = true;
        });
    }
  }

  status(leases: Lease[]): WatcherStatus[] {
    const now = this.now();
    const demand = new Map<string, number>();
    for (const lease of leases) {
      if (leaseRequestsWatch(lease, now)) {
        demand.set(lease.projectRoot, (demand.get(lease.projectRoot) ?? 0) + 1);
      }
    }
    for (const [projectRoot, entry] of [...this.watchers])
      if (entry.done) this.watchers.delete(projectRoot);
    const projects = new Set<string>([...this.watchers.keys(), ...demand.keys()]);
    const result: WatcherStatus[] = [];
    for (const projectRoot of projects) {
      const entry = this.watchers.get(projectRoot);
      const s: WatcherStatus = {
        projectRoot,
        demand: demand.get(projectRoot) ?? 0,
        active: false,
        state: "stopped",
      };
      if (entry) {
        s.state = entry.state;
        s.active = entry.state === "running" || entry.state === "grace";
        s.graceUntil = entry.graceUntil ? nowString(entry.graceUntil) : "0001-01-01T00:00:00Z";
        s.gracePending = entry.state === "grace";
      }
      result.push(s);
    }
    result.sort((a, b) => byteCompare(a.projectRoot, b.projectRoot));
    return result;
  }

  stop(): void {
    for (const entry of this.watchers.values()) {
      entry.abort.abort();
      entry.state = "cancelRequested";
    }
  }

  hasActiveOrGrace(): boolean {
    for (const [k, e] of [...this.watchers]) if (e.done) this.watchers.delete(k);
    return this.watchers.size > 0;
  }
}

// --- daemon -------------------------------------------------------------------------------------

const processStartedAt = nowString();

function writeStatusFile(leases: Lease[], projects: string[], watchers: WatcherStatus[]): void {
  writeJSON(statusPath(), {
    pid: process.pid,
    ...(VERSION ? { version: VERSION } : {}),
    startedAt: processStartedAt,
    updatedAt: nowString(),
    projects,
    clients: leases.map(leaseJson),
    ...(watchers.length > 0 ? { watchers: watchers.map(watcherJson) } : {}),
  });
}

/** What `status.json` says apart from its timestamps and lease heartbeats. */
function statusKey(leases: Lease[], projects: string[], watchers: WatcherStatus[]): string {
  return JSON.stringify([
    projects,
    leases.map((l) => [l.id, l.projectRoot, l.clientKind, l.watch, l.pid]),
    watchers.map(watcherJson),
  ]);
}

/** Status is rewritten when it changes, and otherwise at most this often. */
const STATUS_REFRESH_MS = 30_000;
const IDLE_POLL_MAX_MS = 5_000;
const KEEP_ALIVE_REFRESH_MS = 2_000;
/** How often a daemon rechecks whether it is the runner (one small file read). */
const ROLE_REFRESH_MS = 2_000;
const STANDBY_SCAN: QueueScan = { pending: 0, fingerprint: "" };
/** Registered project roots that stay missing this long, and hold no jobs, are unregistered. */
const MISSING_PROJECT_GRACE_MS = 30 * 24 * 3_600_000;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000;
const ORPHAN_QUEUE_MIN_AGE_MS = 7 * 24 * 3_600_000;

export interface QueueScan {
  /** The job to run next: earliest due across projects, skipping `avoid` while another has work. */
  next?: { storeRoot: string; job: Job };
  /** Jobs that are not dead letters, due or not. */
  pending: number;
  /** Earliest runAfter of a job that is not due yet, so the daemon sleeps no longer than that. */
  wakeAt?: number;
  /** Changes whenever a project's jobs change; used to leave the idle backoff. */
  fingerprint: string;
}

const jobIsBefore = (a: Job, b: Job): boolean =>
  parseMs(a.runAfter) < parseMs(b.runAfter) ||
  (parseMs(a.runAfter) === parseMs(b.runAfter) && parseMs(a.requestedAt) < parseMs(b.requestedAt));

/**
 * One pass over every project (a stat each when unchanged) that yields the next job, the pending
 * count and the next wake time. `avoid` is the project served last: round-robin, so one busy
 * project cannot starve the others.
 */
export function scanQueues(
  projects: string[],
  avoid?: string,
  now: number = Date.now(),
): QueueScan {
  let chosen: { storeRoot: string; job: Job } | undefined;
  let fallback: { storeRoot: string; job: Job } | undefined;
  let pending = 0;
  let wakeAt: number | undefined;
  const parts: string[] = [];
  for (const projectRoot of projects) {
    let entry: QueueScanEntry;
    try {
      entry = loadQueueEntry(projectRoot);
    } catch {
      continue;
    }
    const live = entry.live.length;
    if (live === 0) continue;
    pending += live;
    parts.push(`${projectRoot}:${live}:${entry.state.updatedAt ?? ""}`);
    // Sorted by due time: the first job is the best candidate, and if it is not due yet nothing is.
    const first = entry.live[0] as { job: Job; due: number };
    if (first.due > now) {
      if (wakeAt === undefined || first.due < wakeAt) wakeAt = first.due;
      continue;
    }
    const best = first.job;
    const candidate = { storeRoot: projectRoot, job: best };
    const slot = projectRoot === avoid ? "fallback" : "chosen";
    const current = slot === "chosen" ? chosen : fallback;
    if (!current || jobIsBefore(best, current.job)) {
      if (slot === "chosen") chosen = candidate;
      else fallback = candidate;
    }
  }
  const pick = chosen ?? fallback;
  return {
    ...(pick ? { next: { storeRoot: pick.storeRoot, job: { ...pick.job } } } : {}),
    pending,
    ...(wakeAt !== undefined ? { wakeAt } : {}),
    fingerprint: parts.join("|"),
  };
}

export function nextReadyJob(projects: string[]): { storeRoot: string; job: Job } | undefined {
  return scanQueues(projects).next;
}

/** The pause after a job: as long as the job ran, at least 100 ms and at most 2 s. */
export function jobGapMs(ranMs: number): number {
  const fixed = process.env.KNOWNS_RUNTIME_JOB_GAP_MS;
  if (fixed !== undefined && fixed !== "") {
    const n = Number(fixed);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return Math.min(2_000, Math.max(100, ranMs));
}

/** Files the daemon writes itself: they must not wake its own sleep. */
const OWN_WRITES =
  /^(status\.json|semantic-status\.json|projects-missing\.json|knowns-runtime\.pid|runner\.json|runner\.lock)(\.\d+)?(\.tmp)?$/;

/**
 * One fs.watch per runtime directory (root, leases, queues): a lease, an enqueue, a reload request
 * or a stop flag ends the idle wait at once, so the idle tick can be long. If a watch cannot start
 * the daemon still polls at the idle interval.
 */
function watchRuntimeDirs(): {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  close: () => void;
} {
  let woken = false;
  let release: (() => void) | undefined;
  const poke = () => {
    woken = true;
    release?.();
  };
  const watchers: FSWatcher[] = [];
  for (const dir of [runtimeRoot(), leaseDir(), dirname(queuePath("x"))]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      const w = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && OWN_WRITES.test(String(filename))) return;
        poke();
      });
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // polling fallback
    }
  }
  return {
    async sleep(ms, signal) {
      if (woken) {
        woken = false;
        return;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          release = undefined;
          resolve();
        }
        release = done;
        if (signal?.aborted) return done();
        signal?.addEventListener("abort", done, { once: true });
      });
      woken = false;
    },
    close() {
      for (const w of watchers) w.close();
    },
  };
}

/** RunDaemonWithOptions. Resolves when the daemon decides to exit (idle, stop flag, abort). */
export async function runDaemon(signal: AbortSignal, opts: DaemonOptions): Promise<void> {
  mkdirSync(runtimeRoot(), { recursive: true, mode: 0o755 });
  // Version scoped (spec D3): register, then try to become the runner, the one daemon that runs
  // queue jobs and watchers and owns the pid and status files 0.34.x reads.
  registerDaemon(VERSION);
  let isRunner = claimRunner(VERSION);
  let roleCheckedAt = Date.now();
  const takeRunnerFiles = (): void => {
    writeFileSync(pidFile(), String(process.pid), { mode: 0o644 });
    rmSync(stopFlagPath(), { force: true });
  };
  if (isRunner) takeRunnerFiles();
  goLogf(`[runtime] started (version=${VERSION}, role=${isRunner ? "runner" : "standby"})`);

  const serviceAbort = new AbortController();
  const services = (opts.services ?? []).map((run) => run(serviceAbort.signal).catch(() => {}));
  const watchLifecycle = new WatchLifecycle();
  let running:
    | { storeRoot: string; job: Job; done: Promise<Error | undefined>; startedMs: number }
    | undefined;
  let idleSince = 0;
  // Idle cost: the tick backs off from POLL to IDLE_POLL_MAX_MS while nothing changes, and a file
  // event in the runtime directories (enqueue, lease, reload, stop) ends the wait at once.
  let intervalMs = DEFAULT_POLL_INTERVAL_MS;
  let lastFingerprint = "";
  let lastLeaseIdentity = "";
  let lastServed: string | undefined;
  let cooldownUntil = 0;
  let lastStatusKey = "";
  let lastStatusAt = 0;
  let nextHousekeeping = 0;
  let keepAliveValue = false;
  let keepAliveAt = 0;
  let missingRoots = new Set<string>();
  const wake = watchRuntimeDirs();

  try {
    for (;;) {
      const tickNow = Date.now();
      const allLeases = (() => {
        try {
          return activeLeases();
        } catch {
          return [] as Lease[];
        }
      })();
      if (tickNow - roleCheckedAt >= ROLE_REFRESH_MS) {
        roleCheckedAt = tickNow;
        const was = isRunner;
        isRunner = checkRunner(VERSION);
        // A runner that never noticed it was replaced (the newer daemon died within one refresh)
        // must still take the files back: the pid file went with the newer daemon.
        if (isRunner && (!was || readPID() !== process.pid)) {
          takeRunnerFiles();
          lastStatusKey = "";
          goLogf("[runtime] role: runner");
        } else if (!isRunner && was) {
          goLogf("[runtime] role: standby (a newer daemon runs jobs)");
        }
      }
      // A daemon answers for its own version's leases; only the runner watches and runs jobs.
      const { own: leases, watchFor } = partitionLeases(allLeases, VERSION, isRunner);
      let projects: string[] = [];
      try {
        projects = registeredProjects();
      } catch {
        projects = [];
      }
      for (const lease of watchFor)
        if (!projects.includes(lease.projectRoot)) projects.push(lease.projectRoot);
      if (tickNow >= nextHousekeeping) {
        nextHousekeeping = tickNow + HOUSEKEEPING_INTERVAL_MS;
        try {
          pruneRuntimeFiles(tickNow);
        } catch (err) {
          goLogf(`[runtime] housekeeping failed: ${(err as Error).message}`);
        }
        missingRoots = new Set(projects.filter(projectRootMissing));
      }
      const leasedRoots = new Set(watchFor.map((l) => l.projectRoot));
      const scanned = projects.filter((p) => leasedRoots.has(p) || !missingRoots.has(p));
      watchLifecycle.reconcile(watchFor, opts.watcherFactory);
      const watcherStates = watchLifecycle.status(watchFor);

      const leaseIdentity = leases.map((l) => `${l.id}:${l.projectRoot}:${l.watch}`).join("|");
      let busy = running !== undefined || leaseIdentity !== lastLeaseIdentity;
      lastLeaseIdentity = leaseIdentity;
      const scan = isRunner ? scanQueues(scanned, lastServed, tickNow) : STANDBY_SCAN;
      if (scan.fingerprint !== lastFingerprint) {
        lastFingerprint = scan.fingerprint;
        busy = true;
      }
      const pendingJobs = scan.pending;
      if (running === undefined && isRunner) {
        let request: ReloadRequest | undefined;
        let reloadErr: unknown;
        try {
          request = pendingReload();
        } catch (err) {
          reloadErr = err;
        }
        if (reloadErr) {
          goLogf(`[runtime] reload request unreadable: ${(reloadErr as Error).message}`);
        } else if (request) {
          try {
            await acknowledgeReload(request, opts.reloadHandler);
          } catch (err) {
            goLogf(`[runtime] reload failed: ${(err as Error).message}`);
          }
          try {
            writeStatusFile(watchFor, projects, watcherStates);
            lastStatusKey = statusKey(watchFor, projects, watcherStates);
            lastStatusAt = Date.now();
          } catch {
            // ignore
          }
          intervalMs = DEFAULT_POLL_INTERVAL_MS;
          continue;
        }
        // At most one job runs at a time, and a finished job is followed by a pause as long as the
        // job took, so a backlog runs at half duty instead of in one burst.
        const next = tickNow >= cooldownUntil ? scan.next : undefined;
        if (scan.next && !next) busy = true;
        if (next) {
          try {
            const started = markJobStarted(next.storeRoot, next.job.id);
            lastServed = next.storeRoot;
            const done = (async (): Promise<Error | undefined> => {
              try {
                await opts.executor(next.storeRoot, started);
                return undefined;
              } catch (err) {
                return err instanceof Error ? err : new Error(String(err));
              }
            })();
            running = {
              storeRoot: next.storeRoot,
              job: started,
              done,
              startedMs: Date.now(),
            };
            busy = true;
          } catch {
            // job vanished
          }
        }
      }
      if (isRunner) {
        const statusNow = Date.now();
        const key = statusKey(watchFor, projects, watcherStates);
        if (key !== lastStatusKey || statusNow - lastStatusAt >= STATUS_REFRESH_MS) {
          try {
            writeStatusFile(watchFor, projects, watcherStates);
            lastStatusKey = key;
            lastStatusAt = statusNow;
          } catch {
            // ignore
          }
        }
      }
      // The stop flag addresses the daemon that owns the pid file (what `runtime stop` targets).
      if (shouldStop() && readPID() === process.pid) {
        rmSync(stopFlagPath(), { force: true });
        return;
      }
      // keepAlive probes the store registry from disk; it only decides when to exit, so a
      // answer a few seconds old is as good, and a busy daemon does not ask on every tick.
      if (
        opts.keepAlive &&
        Date.now() - keepAliveAt >= Math.min(KEEP_ALIVE_REFRESH_MS, idleTimeoutMs() / 4)
      ) {
        keepAliveValue = opts.keepAlive() === true;
        keepAliveAt = Date.now();
      }
      const keepAlive = keepAliveValue;
      if (
        leases.length === 0 &&
        pendingJobs === 0 &&
        running === undefined &&
        !watchLifecycle.hasActiveOrGrace() &&
        !keepAlive &&
        opts.busy?.() !== true
      ) {
        if (idleSince === 0) idleSince = Date.now();
        else if (Date.now() - idleSince >= idleTimeoutMs()) return;
      } else {
        idleSince = 0;
      }

      if (signal.aborted) return;
      intervalMs = busy
        ? DEFAULT_POLL_INTERVAL_MS
        : Math.min(intervalMs * 2, idleTimeoutMs() / 2, IDLE_POLL_MAX_MS);
      let waitMs = Math.max(intervalMs, DEFAULT_POLL_INTERVAL_MS / 10);
      const sleepNow = Date.now();
      if (scan.wakeAt !== undefined)
        waitMs = Math.min(waitMs, Math.max(50, scan.wakeAt - sleepNow));
      if (cooldownUntil > sleepNow)
        waitMs = Math.min(waitMs, Math.max(50, cooldownUntil - sleepNow));
      const tick = running ? sleep(waitMs, signal) : wake.sleep(waitMs, signal);
      if (running) {
        const current = running;
        const outcome = await Promise.race([
          tick.then(() => "tick" as const),
          current.done.then((err) => ({ err })),
        ]);
        if (outcome !== "tick") {
          try {
            completeJob(current.storeRoot, current.job, outcome.err);
          } catch {
            // ignore
          }
          running = undefined;
          cooldownUntil = Date.now() + jobGapMs(Date.now() - current.startedMs);
        }
      } else {
        await tick;
      }
      if (signal.aborted) return;
    }
  } finally {
    wake.close();
    watchLifecycle.stop();
    serviceAbort.abort();
    await Promise.allSettled(services);
    if (readPID() === process.pid) rmSync(pidFile(), { force: true });
    releaseRunner();
    unregisterDaemon(VERSION);
  }
}
