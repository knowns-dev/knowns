// `knowns runtime ps`, `reload` and `logs` (internal/cli/runtime.go), plus the box / duration
// helpers they share with `runtime retry`, and the slice of internal/services/status.go
// (DetectAll) that does not need the LSP manager: the Cloudflared and Embedding detectors.
// The LSP detector is a seam (`serviceSeams.detectLsp`) that is empty until the LSP manager lands.
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { buildSearchEnvironment } from "../../domain/searchenv/index.ts";
import {
  globalRoot,
  isProcessAlive,
  isRunning,
  type Job,
  type JobResult,
  jobJson,
  type Lease,
  loadQueue,
  loadReloadStatus,
  loadStatus,
  mcpLogPath,
  type ReloadRequest,
  type ReloadStatus,
  requestReload,
  resultJson,
  runtimeLogPath,
  runtimeRoot,
  type Status,
  statusJson,
  type WatcherStatus,
  waitForReload,
} from "../../runtime/queue.ts";
import {
  resolveSemanticSearchSettings,
  semanticRuntimeDisabledReason,
} from "../../search/config.ts";
import {
  resolveSemanticIndexReadiness,
  type SemanticIndexReadiness,
} from "../../search/readiness.ts";
import { goTimeString } from "../../search/time.ts";
import { createStorage } from "../../storage/adapters.ts";
import { defineCommand } from "../core/define.ts";
import { formatGoDuration } from "../core/gofmt.ts";
import { getStoreErr } from "../core/helpers.ts";
import {
  StyleBold,
  StyleDim,
  StyleError,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";
import { padRight, stringWidth, truncateVisible } from "./doc-support.ts";
import { renderBadge, truncate } from "./search-support.ts";

const COLOR_BLUE = 34;
const GO_ZERO = "0001-01-01T00:00:00Z";
const DEFAULT_CLIENT_LIMIT = 6;
const DEFAULT_FAILURE_LIMIT = 3;
const SEMANTIC_STATUS_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_IDLE_TIMEOUT_NS = 120_000_000_000;

// --- Go time and duration helpers -----------------------------------------------------------------

const TIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** time.Time.IsZero for a stored timestamp. */
function isZeroTime(s: string | undefined | null): boolean {
  return s === undefined || s === null || s === "" || s === GO_ZERO;
}

/** Nanoseconds since the epoch of a stored RFC 3339 timestamp (0 when unparseable). */
function timeNs(s: string | undefined | null): bigint {
  if (s === undefined || s === null || s === "") return 0n;
  const m = TIME_RE.exec(s);
  if (!m) return 0n;
  const sec = BigInt(Math.floor(Date.parse(`${m[1]}${m[3]}`) / 1000));
  const frac = BigInt((m[2] ?? "").padEnd(9, "0").slice(0, 9) || "0");
  return sec * 1_000_000_000n + frac;
}

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/** time.Time.Format(time.RFC3339): whole seconds, the stored offset ("Z" for UTC). */
function rfc3339(s: string): string {
  const m = TIME_RE.exec(s);
  if (!m) return s;
  const zone = m[3] === "+00:00" || m[3] === "-00:00" ? "Z" : m[3];
  return `${m[1]}${zone}`;
}

/** time.Duration.Round(unit) for a nanosecond count (halves round away from zero). */
function roundNs(d: bigint, unit: bigint): bigint {
  const r = d % unit;
  if (d < 0n) {
    const rr = -r;
    return rr + rr < unit ? d + rr : d - (unit - rr);
  }
  return r + r < unit ? d - r : d + (unit - r);
}

const SECOND = 1_000_000_000n;
const MILLISECOND = 1_000_000n;

/** time.Duration.String of a rounded span. */
function durString(ns: bigint): string {
  return formatGoDuration(Number(ns));
}

// --- text helpers (byte-exact with the Go ones) ---------------------------------------------------

/** shorten: "-" for empty, else the last 49 bytes behind an ellipsis when longer than 50 bytes. */
export function shorten(s: string): string {
  if (s === "") return "-";
  const b = Buffer.from(s);
  if (b.length > 50) return `…${b.subarray(b.length - 49).toString()}`;
  return s;
}

/** shortenTarget: like shorten with a caller-chosen byte width. */
export function shortenTarget(s: string, max: number): string {
  if (s === "") return "-";
  const b = Buffer.from(s);
  if (b.length <= max) return s;
  return `…${b.subarray(b.length - (max - 1)).toString()}`;
}

/**
 * projectDisplayName: the project folder of a store root (".knowns" names its parent). Go uses
 * filepath.Base/Dir, so on Windows both separators split the path.
 */
export function projectDisplayName(root: string): string {
  const base = filepathBase(root);
  if (base === ".knowns") return filepathBase(dirname(root));
  return base;
}

/** filepath.Base: "." for "", the separator for a root, else the last element. */
function filepathBase(p: string): string {
  if (p === "") return ".";
  const b = basename(p);
  return b === "" ? sep : b;
}

/** terminalWidth: the TTY width, else $COLUMNS, else 100. */
export function terminalWidth(): number {
  if (process.stdout.isTTY === true && (process.stdout.columns ?? 0) > 0) {
    return process.stdout.columns;
  }
  const raw = process.env.COLUMNS;
  if (raw) {
    const m = /^([+-]?\d+)/.exec(raw);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return 100;
}

/** humanDuration: "1h 2m", "3m 4s" or "5s" for a nanosecond span. */
export function humanDuration(ns: number): string {
  const d = roundNs(BigInt(Math.round(ns)), SECOND);
  const h = d / 3_600_000_000_000n;
  const m = (d % 3_600_000_000_000n) / 60_000_000_000n;
  const s = (d % 60_000_000_000n) / SECOND;
  if (h > 0n) return `${h}h ${m}m`;
  if (m > 0n) return `${m}m ${s}s`;
  return `${s}s`;
}

/** renderBox: a rounded box around `lines` with `title` in the top border. */
export function renderBox(title: string, lines: string[]): string {
  let maxWidth = terminalWidth() - 1;
  if (maxWidth < 40) maxWidth = 40;
  if (maxWidth > 140) maxWidth = 140;
  let innerWidth = stringWidth(title) + 4;
  for (const l of lines) {
    const w = stringWidth(l);
    if (w + 2 > innerWidth) innerWidth = w + 2;
  }
  if (innerWidth > maxWidth - 2) innerWidth = maxWidth - 2;

  const top = `┌─ ${StyleBold.render(title)} ${"─".repeat(Math.max(0, innerWidth - stringWidth(title) - 3))}┐`;
  const bot = `└${"─".repeat(innerWidth)}┘`;

  let b = `${StyleDim.render(top)}\n`;
  for (let l of lines) {
    let w = stringWidth(l);
    const contentMax = innerWidth - 2;
    if (w > contentMax) {
      l = truncateVisible(l, contentMax);
      w = stringWidth(l);
    }
    const pad = Math.max(0, contentMax - w);
    b += `${StyleDim.render("│ ")}${l}${" ".repeat(pad)}${StyleDim.render(" │")}\n`;
  }
  b += StyleDim.render(bot);
  return b;
}

// --- semantic runtime status ----------------------------------------------------------------------

type Env = Record<string, string | undefined>;

export interface SemanticRuntimeEntryInfo {
  key: string;
  provider: string;
  model: string;
  dimensions: number;
  loaded: boolean;
  activeSessions: number;
  lastUsed: string;
  idleFor: number;
  idleUnloadAfter: string;
  storeConsumers: string[];
  providerIdentity: string;
}

export interface SemanticRuntimeStatus {
  enabled: boolean;
  disabledBy: string;
  /** Nanoseconds. */
  idleTimeout: number;
  lastReloadAt: string;
  reloadGeneration: number;
  reloadRequestId: string;
  entries: SemanticRuntimeEntryInfo[];
}

function defaultSemanticStatus(env: Env): SemanticRuntimeStatus {
  const { disabled, reason } = semanticRuntimeDisabledReason(env);
  return {
    enabled: !disabled,
    disabledBy: reason,
    idleTimeout: DEFAULT_IDLE_TIMEOUT_NS,
    lastReloadAt: GO_ZERO,
    reloadGeneration: 0,
    reloadRequestId: "",
    entries: [],
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function entryFrom(raw: unknown): SemanticRuntimeEntryInfo {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    key: str(e.key),
    provider: str(e.provider),
    model: str(e.model),
    dimensions: num(e.dimensions),
    loaded: e.loaded === true,
    activeSessions: num(e.activeSessions),
    lastUsed: str(e.lastUsed) || GO_ZERO,
    idleFor: num(e.idleFor),
    idleUnloadAfter: str(e.idleUnloadAfter) || GO_ZERO,
    storeConsumers: Array.isArray(e.storeConsumers)
      ? e.storeConsumers.filter((c): c is string => typeof c === "string")
      : [],
    providerIdentity: str(e.providerIdentity),
  };
}

/**
 * search.ObservedSemanticRuntimeStatus: the snapshot the daemon persists, when it is fresh and the
 * daemon is alive; otherwise the default (idle) status.
 */
export function observedSemanticRuntimeStatus(env: Env = process.env): SemanticRuntimeStatus {
  const { disabled } = semanticRuntimeDisabledReason(env);
  if (disabled) return defaultSemanticStatus(env);
  let snapshot: { updatedAt?: unknown; status?: unknown };
  try {
    snapshot = JSON.parse(readFileSync(join(runtimeRoot(), "semantic-status.json"), "utf8"));
  } catch {
    return defaultSemanticStatus(env);
  }
  const updatedAt = str(snapshot?.updatedAt);
  if (isZeroTime(updatedAt)) return defaultSemanticStatus(env);
  if (Number(nowNs() - timeNs(updatedAt)) / 1e6 > SEMANTIC_STATUS_MAX_AGE_MS) {
    return defaultSemanticStatus(env);
  }
  if (!isRunning()) return defaultSemanticStatus(env);
  const s = (snapshot.status ?? {}) as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    disabledBy: str(s.disabledBy),
    idleTimeout: num(s.idleTimeout),
    lastReloadAt: str(s.lastReloadAt) || GO_ZERO,
    reloadGeneration: num(s.reloadGeneration),
    reloadRequestId: str(s.reloadRequestId),
    entries: Array.isArray(s.entries) ? s.entries.map(entryFrom) : [],
  };
}

function semanticStatusJson(s: SemanticRuntimeStatus): unknown {
  return {
    enabled: s.enabled,
    ...(s.disabledBy ? { disabledBy: s.disabledBy } : {}),
    idleTimeout: s.idleTimeout,
    lastReloadAt: goTimeString(s.lastReloadAt),
    ...(s.reloadGeneration ? { reloadGeneration: s.reloadGeneration } : {}),
    ...(s.reloadRequestId ? { reloadRequestId: s.reloadRequestId } : {}),
    ...(s.entries.length > 0
      ? {
          entries: s.entries.map((e) => ({
            key: e.key,
            provider: e.provider,
            model: e.model,
            dimensions: e.dimensions,
            loaded: e.loaded,
            ...(e.activeSessions ? { activeSessions: e.activeSessions } : {}),
            lastUsed: goTimeString(e.lastUsed),
            ...(e.idleFor ? { idleFor: e.idleFor } : {}),
            idleUnloadAfter: goTimeString(e.idleUnloadAfter),
            ...(e.storeConsumers.length > 0 ? { storeConsumers: e.storeConsumers } : {}),
            ...(e.providerIdentity ? { providerIdentity: e.providerIdentity } : {}),
          })),
        }
      : {}),
  };
}

function reloadJson(r: ReloadStatus): unknown {
  return {
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.generation ? { generation: r.generation } : {}),
    requestedAt: goTimeString(r.requestedAt || GO_ZERO),
    processedAt: goTimeString(r.processedAt || GO_ZERO),
    ...(r.pid ? { pid: r.pid } : {}),
    success: r.success === true,
    ...(r.error ? { error: r.error } : {}),
  };
}

function readinessJson(r: SemanticIndexReadiness | undefined): unknown {
  if (!r) return null;
  return {
    enabled: r.enabled,
    ...(r.optedOut ? { optedOut: true } : {}),
    ...(r.backend ? { backend: r.backend } : {}),
    ...(r.mode ? { mode: r.mode } : {}),
    ready: r.ready === true,
    ...(r.stale ? { stale: true } : {}),
    ...(r.degraded ? { degraded: true } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.dimensions ? { dimensions: r.dimensions } : {}),
    ...(r.chunkVersion ? { chunkVersion: r.chunkVersion } : {}),
    ...(r.chunkCount ? { chunkCount: r.chunkCount } : {}),
    ...(r.indexedAt ? { indexedAt: goTimeString(r.indexedAt) } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.entities && r.entities.length > 0 ? { entities: r.entities.map(entityJson) } : {}),
    ...(r.entityStaleCount ? { entityStaleCount: r.entityStaleCount } : {}),
    ...(r.entitiesOnlyStale ? { entitiesOnlyStale: true } : {}),
  };
}

function entityJson(e: NonNullable<SemanticIndexReadiness["entities"]>[number]): unknown {
  return {
    entityType: e.entityType,
    entityId: e.entityId,
    ...(e.canonicalHash ? { canonicalHash: e.canonicalHash } : {}),
    ...(e.indexedHash ? { indexedHash: e.indexedHash } : {}),
    ...(e.revision ? { revision: e.revision } : {}),
    ...(e.indexedRevision ? { indexedRevision: e.indexedRevision } : {}),
    ...(e.path ? { path: e.path } : {}),
    ...(e.indexedPath ? { indexedPath: e.indexedPath } : {}),
    stale: e.stale === true,
  };
}

// --- services (internal/services/status.go) -------------------------------------------------------

export interface ServiceStatus {
  name: string;
  type: string;
  status: string;
  pid?: number;
  port?: number;
  /** Nanoseconds. */
  uptime?: number;
  enabledInConfig: boolean;
  details: Record<string, string>;
}

/** Detectors owned by unported subsystems. `detectLsp` returns the project's LSP statuses. */
export const serviceSeams: { detectLsp?: () => ServiceStatus[] } = {};

function serviceJson(s: ServiceStatus): unknown {
  const keys = Object.keys(s.details).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const details: Record<string, string> = {};
  for (const k of keys) details[k] = s.details[k] as string;
  return {
    name: s.name,
    type: s.type,
    status: s.status,
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.port ? { port: s.port } : {}),
    ...(s.uptime ? { uptime: s.uptime } : {}),
    enabledInConfig: s.enabledInConfig,
    ...(keys.length > 0 ? { details } : {}),
  };
}

function detectCloudflared(): ServiceStatus[] {
  const ss: ServiceStatus = {
    name: "Cloudflared",
    type: "cloudflared",
    status: "stopped",
    enabledInConfig: true,
    details: {},
  };
  if (!Bun.which("cloudflared")) {
    ss.details.reason = "cloudflared not installed";
    return [ss];
  }
  const stateDir = globalRoot();
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [ss];
  }
  names.sort();
  for (const name of names) {
    if (name.length < 15 || !name.endsWith(".pid") || !name.startsWith("cloudflared-")) continue;
    const pidFile = join(stateDir, name);
    let data: string;
    try {
      data = readFileSync(pidFile, "utf8");
    } catch {
      continue;
    }
    const port = Number.parseInt(name.slice(12, -4), 10) || 0;
    const pidText = data.trim();
    const pid = /^[+-]?\d+$/.test(pidText) ? Number(pidText) : 0;
    if (pid <= 0) continue;
    // Detection removes stale marker files in Go (DetectAll); a dead process is skipped here and
    // the marker is left alone.
    if (!isProcessAlive(pid)) continue;
    let url = "";
    try {
      url = readFileSync(`${pidFile.slice(0, -3)}url`, "utf8").trim();
    } catch {
      // no url file
    }
    ss.status = "running";
    ss.pid = pid;
    ss.port = port;
    if (url) ss.details.url = url;
    try {
      ss.uptime = Date.now() * 1e6 - statSync(pidFile).mtimeMs * 1e6;
    } catch {
      // keep zero
    }
    return [ss];
  }
  return [ss];
}

const SEMANTIC_JOB_KINDS = new Set([
  "index-task",
  "index-doc",
  "remove-task",
  "remove-doc",
  "index-memory",
  "remove-memory",
  "index-decision",
  "remove-decision",
  "semantic-search",
  "reindex-search",
]);

function addSemanticRuntimeDetails(ss: ServiceStatus, rs: SemanticRuntimeStatus): void {
  const d = ss.details;
  d.runtime_enabled = String(rs.enabled);
  if (rs.disabledBy) d.runtime_disabled_by = rs.disabledBy;
  if (rs.idleTimeout > 0) {
    d.runtime_idle_timeout = durString(roundNs(BigInt(rs.idleTimeout), MILLISECOND));
  }
  d.runtime_entries = String(rs.entries.length);
  d.runtime_loaded = "false";
  if (rs.entries.length === 0) return;

  let loaded = false;
  let activeSessions = 0;
  const consumers: string[] = [];
  let idleUnloadAfter: bigint | undefined;
  let idleUnloadText = "";
  let idleFor = 0;
  for (const e of rs.entries) {
    if (e.loaded) loaded = true;
    activeSessions += e.activeSessions;
    consumers.push(...e.storeConsumers);
    const after = timeNs(e.idleUnloadAfter);
    if (
      !isZeroTime(e.idleUnloadAfter) &&
      (idleUnloadAfter === undefined || after > idleUnloadAfter)
    ) {
      idleUnloadAfter = after;
      idleUnloadText = e.idleUnloadAfter;
    }
    if (e.idleFor > idleFor) idleFor = e.idleFor;
    if (!d.provider && e.provider) d.provider = e.provider;
    if (!d.model && e.model) d.model = e.model;
    if (!d.dimensions && e.dimensions > 0) d.dimensions = String(e.dimensions);
    if (!d.provider_identity && e.providerIdentity) d.provider_identity = e.providerIdentity;
  }
  d.runtime_loaded = String(loaded);
  if (activeSessions > 0) d.active_sessions = String(activeSessions);
  const unique = [...new Set(consumers.filter((c) => c !== ""))];
  if (unique.length > 0) d.consumers = unique.join(",");
  if (idleUnloadAfter !== undefined) d.idle_unload_after = rfc3339(idleUnloadText);
  if (idleFor > 0) d.idle_for = durString(roundNs(BigInt(Math.round(idleFor)), SECOND));
}

function addSemanticJobDetails(ss: ServiceStatus, storeRoot: string): void {
  let queue: ReturnType<typeof loadQueue>;
  try {
    queue = loadQueue(storeRoot);
  } catch (err) {
    ss.details.job_status_error = (err as Error).message;
    return;
  }
  let running = 0;
  let queued = 0;
  let recent = 0;
  let failed = 0;
  let latestSeen = false;
  let latestFailed = false;
  let latestErr = "";
  for (const job of queue.jobs) {
    if (!job || !SEMANTIC_JOB_KINDS.has(job.kind)) continue;
    if (job.startedAt !== undefined && job.startedAt !== null) running++;
    else queued++;
  }
  for (const result of queue.recent ?? []) {
    if (!SEMANTIC_JOB_KINDS.has(result.kind)) continue;
    if (!latestSeen) {
      latestSeen = true;
      latestFailed = !result.success;
      latestErr = result.error ?? "";
    }
    recent++;
    if (!result.success) failed++;
  }
  const d = ss.details;
  if (running > 0) d.running_jobs = String(running);
  if (queued > 0) d.queued_jobs = String(queued);
  if (recent > 0) d.recent_jobs = String(recent);
  if (failed > 0) d.recent_failed_jobs = String(failed);
  if (latestFailed) {
    d.degraded = "true";
    if (latestErr) d.last_error = latestErr;
  }
}

type Store = Awaited<ReturnType<typeof getStoreErr>>;

/** services.DetectEmbeddingReadOnly (also used by doctor). */
export function detectEmbedding(
  store: Store | undefined,
  env: Record<string, string | undefined>,
): ServiceStatus[] {
  const ss: ServiceStatus = {
    name: "Embedding",
    type: "embedding",
    status: "stopped",
    enabledInConfig: true,
    details: {},
  };
  const d = ss.details;
  const runtimeStatus = observedSemanticRuntimeStatus(env);
  addSemanticRuntimeDetails(ss, runtimeStatus);
  d.runtime_log = runtimeLogPath();
  if (!store) {
    ss.status = "disabled";
    ss.enabledInConfig = false;
    d.reason = "project store unavailable";
    return [ss];
  }
  addSemanticJobDetails(ss, store.root);

  const storage = createStorage(store);
  let semCfg: ReturnType<typeof resolveSemanticSearchSettings>;
  try {
    semCfg = resolveSemanticSearchSettings(storage.config.load().settings.semanticSearch);
  } catch {
    ss.status = "disabled";
    ss.enabledInConfig = false;
    d.reason = "could not load project config";
    return [ss];
  }
  if (!semCfg?.enabled) {
    ss.status = "disabled";
    ss.enabledInConfig = false;
    d.reason = "semantic search not enabled in project config";
    return [ss];
  }
  if (!semCfg.model) {
    ss.status = "error";
    d.error = "semantic model not configured";
    d.degraded = "true";
    return [ss];
  }
  if (!runtimeStatus.enabled) {
    ss.status = "disabled";
    d.reason = "semantic runtime disabled";
    return [ss];
  }

  ss.enabledInConfig = true;
  const provider = semCfg.provider ?? "";
  d.provider = provider === "" ? "local" : provider;

  switch (provider) {
    case "api":
    case "ollama": {
      let registry: ReturnType<ReturnType<typeof buildSearchEnvironment>["embeddingRegistry"]>;
      try {
        registry = buildSearchEnvironment({ env }).embeddingRegistry();
      } catch {
        ss.status = "error";
        d.error = "cannot load embedding settings";
        return [ss];
      }
      const model = registry.models[semCfg.model];
      if (!model) {
        ss.status = "error";
        d.error = `model ${semCfg.model} not found`;
        d.degraded = "true";
        return [ss];
      }
      const prov = registry.providers[model.provider];
      if (!prov) {
        ss.status = "error";
        d.error = `provider ${model.provider} not found`;
        d.degraded = "true";
        return [ss];
      }
      const initErr =
        prov.apiBase === ""
          ? "apiBase is required"
          : model.model === ""
            ? "model is required"
            : model.dimensions <= 0
              ? "dimensions must be positive"
              : "";
      if (initErr) {
        ss.status = "error";
        d.error = `init embedder: ${initErr}`;
        d.degraded = "true";
        return [ss];
      }
      d.model_id = semCfg.model;
      d.model = model.model;
      d.provider_id = model.provider;
      d.api_base = prov.apiBase;
      d.dimensions = String(model.dimensions);
      // setEmbeddingRuntimeActivityStatus
      if (d.runtime_loaded === "true") ss.status = "running";
      else if (d.degraded === "true") ss.status = "error";
      else {
        ss.status = "stopped";
        d.note = "runtime idle; model not loaded";
      }
      break;
    }
    default:
      ss.status = "stopped";
      d.reason = `unknown provider: ${provider}`;
      d.degraded = "true";
  }
  return [ss];
}

function sortServiceStatuses(statuses: ServiceStatus[]): void {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  statuses.sort((a, b) => {
    const ra = a.status === "running";
    const rb = b.status === "running";
    if (ra !== rb) return ra ? -1 : 1;
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    if (na !== nb) return cmp(na, nb);
    if (a.type !== b.type) return cmp(a.type, b.type);
    return cmp(a.status, b.status);
  });
}

/** services.DetectAll without the LSP inventory (see `serviceSeams`). */
export function detectAllServices(
  store: Store | undefined,
  env: Record<string, string | undefined> = process.env,
): ServiceStatus[] {
  const results = [
    ...(serviceSeams.detectLsp?.() ?? []),
    ...detectCloudflared(),
    ...detectEmbedding(store, env),
  ];
  sortServiceStatuses(results);
  return results;
}

// --- ps data --------------------------------------------------------------------------------------

interface ProjectSnapshot {
  root: string;
  running: Job[];
  queued: Job[];
  recent: JobResult[];
}

function collectProjectJobs(status: Status): ProjectSnapshot[] {
  const out: ProjectSnapshot[] = [];
  for (const p of status.projects) {
    let queue: ReturnType<typeof loadQueue>;
    try {
      queue = loadQueue(p.projectRoot);
    } catch {
      continue;
    }
    const snap: ProjectSnapshot = { root: p.projectRoot, running: [], queued: [], recent: [] };
    for (const job of queue.jobs) {
      if (job.startedAt !== undefined && job.startedAt !== null) snap.running.push(job);
      else snap.queued.push(job);
    }
    snap.recent = queue.recent ?? [];
    out.push(snap);
  }
  return out;
}

interface PsOptions {
  showJobs: boolean;
  tail: number;
  failedOnly: boolean;
  all: boolean;
  clientLimit: number;
  failureLimit: number;
}

interface FailureSummary {
  project: string;
  kind: string;
  target: string;
  error: string;
  count: number;
  lastDuration: string;
  remediation: string;
  lastCompletedAt: bigint;
}

interface PsSummary {
  clients: number;
  projects: number;
  runningJobs: number;
  queuedJobs: number;
  recentJobs: number;
  failedJobs: number;
  failures: FailureSummary[];
}

interface RecentRow {
  project: string;
  result: JobResult;
}

type Ctx = Parameters<NonNullable<Parameters<typeof defineCommand>[0]["run"]>>[0];

function psOptions(ctx: Ctx): PsOptions {
  let showJobs = ctx.flags.bool("jobs");
  const failedOnly = ctx.flags.bool("failed");
  const all = ctx.flags.bool("all");
  let tail = ctx.flags.int("tail");
  let clientLimit = ctx.flags.int("clients");
  let failureLimit = ctx.flags.int("failures");
  if (tail < 0) tail = 0;
  if (clientLimit < 0) clientLimit = 0;
  if (failureLimit < 0) failureLimit = 0;
  if (all || failedOnly || ctx.flags.changed("tail")) showJobs = true;
  if (all) tail = 0;
  return { showJobs, tail, failedOnly, all, clientLimit, failureLimit };
}

function psErrorSummary(errText: string): string {
  let text = errText.replaceAll("\n", " ").split(/\s+/).filter(Boolean).join(" ");
  if (text === "") return "unknown error";
  for (const fragment of [
    "semantic runtime unavailable",
    "embedding model",
    "provider is unavailable",
  ]) {
    const idx = text.indexOf(fragment);
    if (idx >= 0) return truncate(text.slice(idx), 180);
  }
  const idx = text.lastIndexOf(": ");
  if (idx >= 0 && idx + 2 < text.length) return truncate(text.slice(idx + 2), 180);
  text = truncate(text, 180);
  return text;
}

function psRemediation(errText: string): string {
  const lower = errText.toLowerCase();
  if (lower.includes("semantic runtime unavailable") || lower.includes("index is empty")) {
    return "knowns search --reindex";
  }
  return "";
}

function summarizeFailures(snapshots: ProjectSnapshot[], limit: number): FailureSummary[] {
  const groups = new Map<string, FailureSummary>();
  for (const snap of snapshots) {
    const project = projectDisplayName(snap.root);
    for (const result of snap.recent) {
      if (result.success) continue;
      const errText = result.error ?? "";
      const errSummary = psErrorSummary(errText);
      const key = [project, result.kind, result.target ?? "", errSummary].join("\0");
      let group = groups.get(key);
      if (!group) {
        group = {
          project,
          kind: result.kind,
          target: result.target ?? "",
          error: errSummary,
          count: 0,
          lastDuration: "",
          remediation: psRemediation(errText),
          lastCompletedAt: timeNs(GO_ZERO),
        };
        groups.set(key, group);
      }
      group.count++;
      const completed = timeNs(result.completedAt);
      if (completed > group.lastCompletedAt) {
        group.lastCompletedAt = completed;
        group.lastDuration = durString(roundNs(completed - timeNs(result.startedAt), MILLISECOND));
      }
    }
  }
  const failures = [...groups.values()];
  failures.sort((a, b) => {
    if (a.lastCompletedAt !== b.lastCompletedAt)
      return a.lastCompletedAt > b.lastCompletedAt ? -1 : 1;
    return b.count - a.count;
  });
  return limit > 0 && failures.length > limit ? failures.slice(0, limit) : failures;
}

function summarize(status: Status, snapshots: ProjectSnapshot[], failureLimit: number): PsSummary {
  const summary: PsSummary = {
    clients: status.clients.length,
    projects: snapshots.length,
    runningJobs: 0,
    queuedJobs: 0,
    recentJobs: 0,
    failedJobs: 0,
    failures: [],
  };
  for (const snap of snapshots) {
    summary.runningJobs += snap.running.length;
    summary.queuedJobs += snap.queued.length;
    summary.recentJobs += snap.recent.length;
    for (const r of snap.recent) if (!r.success) summary.failedJobs++;
  }
  if (failureLimit > 0) summary.failures = summarizeFailures(snapshots, failureLimit);
  return summary;
}

function recentRows(snapshots: ProjectSnapshot[], opts: PsOptions): RecentRow[] {
  let rows: RecentRow[] = [];
  for (const snap of snapshots) {
    const project = projectDisplayName(snap.root);
    for (const result of snap.recent) {
      if (opts.failedOnly && result.success) continue;
      rows.push({ project, result });
    }
  }
  rows = rows
    .map((row, i) => ({ row, i, t: timeNs(row.result.completedAt) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t > b.t ? -1 : 1))
    .map((x) => x.row);
  if (!opts.all && opts.tail > 0 && rows.length > opts.tail) rows = rows.slice(0, opts.tail);
  return rows;
}

// --- semantic text --------------------------------------------------------------------------------

function semanticIdentity(e: SemanticRuntimeEntryInfo): string {
  if (e.providerIdentity) return e.providerIdentity;
  const parts = [e.provider, e.model];
  if (e.dimensions > 0) parts.push(String(e.dimensions));
  return parts.join("/");
}

function effectiveReload(status: SemanticRuntimeStatus, reload: ReloadStatus) {
  let generation = status.reloadGeneration;
  let processedAt = status.lastReloadAt;
  let requestId = status.reloadRequestId;
  if ((reload.generation ?? 0) > generation) {
    generation = reload.generation ?? 0;
    processedAt = reload.processedAt || GO_ZERO;
    requestId = reload.requestId ?? "";
  }
  return { generation, processedAt, requestId };
}

function semanticRuntimeLines(
  status: SemanticRuntimeStatus,
  reload: ReloadStatus,
  styled: boolean,
): string[] {
  let state = `Enabled   ${status.enabled}`;
  if (!status.enabled && status.disabledBy) state += `  disabledBy=${status.disabledBy}`;
  if (styled && !status.enabled) state = StyleDim.render(state);
  const lines = [state, `Entries   ${status.entries.length}`];
  if (status.idleTimeout > 0) lines.push(`Idle      ${formatGoDuration(status.idleTimeout)}`);
  for (const e of status.entries) {
    let detail = `Provider  ${e.provider}  model=${e.model}  dims=${e.dimensions}  identity=${semanticIdentity(e)}`;
    if (!e.loaded) detail += "  loaded=false";
    if (e.activeSessions > 0) detail += `  sessions=${e.activeSessions}`;
    if (e.storeConsumers.length > 0) detail += `  consumers=${e.storeConsumers.length}`;
    lines.push(detail);
  }
  if (status.entries.length === 0) lines.push("Provider  no loaded providers");
  const { generation, processedAt, requestId } = effectiveReload(status, reload);
  if (generation > 0 || !isZeroTime(processedAt) || requestId !== "") {
    let line = `Reload    generation=${generation}`;
    if (!isZeroTime(processedAt)) line += `  processedAt=${rfc3339(processedAt)}`;
    if (requestId !== "") line += `  requestId=${requestId}`;
    lines.push(line);
  }
  return lines;
}

function semanticRuntimePlainLines(status: SemanticRuntimeStatus, reload: ReloadStatus): string[] {
  const fields = ["semantic", `enabled=${status.enabled}`, `entries=${status.entries.length}`];
  if (status.disabledBy) fields.push(`disabledBy=${status.disabledBy}`);
  const first = status.entries[0];
  if (!first) fields.push("loaded=false");
  else {
    fields.push(
      `provider=${first.provider}`,
      `model=${first.model}`,
      `dimensions=${first.dimensions}`,
      `identity=${semanticIdentity(first)}`,
      `loaded=${first.loaded}`,
    );
    if (first.activeSessions > 0) fields.push(`sessions=${first.activeSessions}`);
    if (first.storeConsumers.length > 0) fields.push(`consumers=${first.storeConsumers.length}`);
  }
  const lines = [fields.join("\t")];
  const { generation, processedAt, requestId } = effectiveReload(status, reload);
  if (generation > 0 || !isZeroTime(processedAt) || requestId !== "") {
    const rf = ["reload", `generation=${generation}`];
    if (!isZeroTime(processedAt)) rf.push(`processedAt=${rfc3339(processedAt)}`);
    if (requestId !== "") rf.push(`requestId=${requestId}`);
    lines.push(rf.join("\t"));
  }
  return lines;
}

/** semanticReindexRemediation. */
export function semanticReindexRemediation(r: SemanticIndexReadiness): string {
  if (!r.enabled || r.optedOut) return "";
  if (r.stale || r.degraded || !r.ready) return "knowns search --reindex";
  return "";
}

function readinessLines(r: SemanticIndexReadiness | undefined, styled: boolean): string[] {
  if (!r) return [];
  let status = "ready";
  if (!r.enabled || r.optedOut) status = "keyword-only";
  else if (r.stale) status = "stale";
  else if (r.degraded || !r.ready) status = "needs reindex";
  let line = `Index     ${status}  backend=${r.backend ?? ""}  mode=${r.mode ?? ""}  chunks=${r.chunkCount ?? 0}`;
  if (r.model) line += `  model=${r.model}`;
  if ((r.dimensions ?? 0) > 0) line += `  dims=${r.dimensions}`;
  if (r.indexedAt) line += `  indexedAt=${rfc3339(r.indexedAt)}`;
  if (r.reason) line += `  reason=${r.reason}`;
  const lines = [line];
  const remediation = semanticReindexRemediation(r);
  if (remediation) {
    let warning = `Reindex   semantic index may not match current embedding identity; run: ${remediation}`;
    if (styled) warning = StyleWarning.render(warning);
    lines.push(warning);
  }
  return lines;
}

function readinessPlainLine(r: SemanticIndexReadiness): string {
  const fields = [
    "index",
    `enabled=${r.enabled}`,
    `backend=${r.backend ?? ""}`,
    `mode=${r.mode ?? ""}`,
    `ready=${r.ready === true}`,
    `stale=${r.stale === true}`,
    `degraded=${r.degraded === true}`,
    `chunks=${r.chunkCount ?? 0}`,
  ];
  if (r.model) fields.push(`model=${r.model}`);
  if ((r.dimensions ?? 0) > 0) fields.push(`dimensions=${r.dimensions}`);
  if ((r.chunkVersion ?? 0) > 0) fields.push(`chunkVersion=${r.chunkVersion}`);
  if (r.indexedAt) fields.push(`indexedAt=${rfc3339(r.indexedAt)}`);
  if (r.reason) fields.push(`reason=${r.reason}`);
  return fields.join("\t");
}

// --- ps rendering ---------------------------------------------------------------------------------

function embeddingParts(s: ServiceStatus): string[] {
  const parts: string[] = [];
  const add = (key: string, label: string) => {
    const v = s.details[key];
    if (v) parts.push(StyleDim.render(`${label}=${shorten(v)}`));
  };
  add("provider", "provider");
  add("model", "model");
  add("dimensions", "dims");
  if (s.details.runtime_loaded) parts.push(StyleDim.render(`loaded=${s.details.runtime_loaded}`));
  if (s.details.active_sessions)
    parts.push(StyleDim.render(`sessions=${s.details.active_sessions}`));
  if (s.details.consumers) {
    const count = s.details.consumers.split(",").filter((p) => p.trim() !== "").length;
    parts.push(StyleDim.render(`consumers=${count}`));
  }
  if (s.details.idle_unload_after) {
    parts.push(StyleDim.render(`idle=${shorten(s.details.idle_unload_after)}`));
  }
  if (s.details.queued_jobs) parts.push(StyleDim.render(`queued=${s.details.queued_jobs}`));
  if (s.details.running_jobs) parts.push(StyleDim.render(`jobs=${s.details.running_jobs}`));
  if (s.details.degraded === "true") parts.push(StyleError.render("degraded"));
  if (s.details.last_error) parts.push(StyleError.render(`error=${shorten(s.details.last_error)}`));
  else if (s.details.error) parts.push(StyleError.render(`error=${shorten(s.details.error)}`));
  add("runtime_log", "log");
  return parts;
}

function serviceLines(ss: ServiceStatus[]): string[] {
  const lines: string[] = [];
  for (const s of ss) {
    let bullet = "○";
    let style = StyleDim;
    if (s.status === "running") {
      bullet = "●";
      style = StyleSuccess;
    }
    const name = style.render(s.name);
    let detail: string;
    if (s.status === "running") {
      const parts = [StyleDim.render(s.status)];
      if ((s.pid ?? 0) > 0) parts.push(StyleDim.render(`pid=${s.pid}`));
      if ((s.port ?? 0) > 0) parts.push(StyleDim.render(`:${s.port}`));
      if ((s.uptime ?? 0) > 0)
        parts.push(StyleDim.render(`uptime=${humanDuration(s.uptime as number)}`));
      if (s.details.version) parts.push(StyleDim.render(`v=${shorten(s.details.version)}`));
      if (s.details.url) parts.push(StyleDim.render(s.details.url));
      detail = parts.join("  ");
    } else {
      const reason = s.details.reason || s.details.note || "";
      detail = reason ? StyleDim.render(`${s.status} (${reason})`) : StyleDim.render(s.status);
    }
    if (s.type === "embedding") {
      const parts = embeddingParts(s);
      if (parts.length > 0) detail += `  ${parts.join("  ")}`;
    }
    if (s.type === "opencode" && s.details.mode) {
      detail += `  ${StyleDim.render(`mode=${s.details.mode}`)}`;
    }
    lines.push(`  ${bullet} ${name}  ${detail}`);
  }
  return lines.length > 0 ? lines : [StyleDim.render("  (no services)")];
}

function lspSummaryLine(ss: ServiceStatus[]): string {
  let running = 0;
  let installed = 0;
  let notInstalled = 0;
  let errors = 0;
  let disabled = 0;
  for (const s of ss) {
    if (s.status === "running") running++;
    else if (s.status === "error") errors++;
    else if (s.status === "disabled") disabled++;
    if (s.details.install_state === "installed") installed++;
    else if (s.details.install_state === "not_installed") notInstalled++;
  }
  const bullet = running > 0 ? "●" : "○";
  const name = running > 0 ? StyleSuccess.render("LSP") : StyleDim.render("LSP");
  const parts = [StyleDim.render(`${ss.length} languages`)];
  if (running > 0) parts.push(StyleDim.render(`${running} running`));
  if (installed > 0) parts.push(StyleDim.render(`${installed} installed`));
  if (notInstalled > 0) parts.push(StyleDim.render(`${notInstalled} not installed`));
  if (errors > 0) parts.push(StyleError.render(`${errors} error`));
  if (disabled > 0) parts.push(StyleDim.render(`${disabled} disabled`));
  parts.push(StyleDim.render("detail: knowns lsp list"));
  return `  ${bullet} ${name}  ${parts.join("  ")}`;
}

function serviceSummaryLines(ss: ServiceStatus[]): string[] {
  const nonLsp = ss.filter((s) => s.type !== "lsp");
  const lsp = ss.filter((s) => s.type === "lsp");
  const hasNonLsp = nonLsp.length > 0;
  const lines = hasNonLsp ? serviceLines(nonLsp) : [StyleDim.render("  (no services)")];
  // Go: formatServiceLines of an empty list yields the placeholder, which stays when LSP rows follow.
  if (lsp.length > 0) lines.push(lspSummaryLine(lsp));
  if (lines.length === 0) return [StyleDim.render("  (no services)")];
  return lines;
}

function watcherState(w: WatcherStatus): string {
  let state = w.active ? "active" : "stopped";
  if (w.gracePending) state = "grace";
  return state;
}

function watcherLines(watchers: WatcherStatus[]): string[] {
  const lines = watchers.map((w) => {
    let line = `${projectDisplayName(w.projectRoot)}  demand=${w.demand}  state=${watcherState(w)}`;
    if (w.gracePending && !isZeroTime(w.graceUntil))
      line += `  until=${rfc3339(w.graceUntil as string)}`;
    return line;
  });
  return lines.length > 0 ? lines : [StyleDim.render("(no knowledge watchers)")];
}

function clientLines(clients: Lease[], limit: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < clients.length; i++) {
    const lease = clients[i] as Lease;
    if (limit > 0 && i >= limit) {
      lines.push(StyleDim.render(`… ${clients.length - limit} more clients`));
      break;
    }
    const age = durString(roundNs(nowNs() - timeNs(lease.updatedAt), SECOND));
    const pidStr = (lease.pid ?? 0) === 0 ? StyleWarning.render("pid=?") : `pid=${lease.pid}`;
    lines.push(
      `${renderBadge(lease.clientKind.toUpperCase(), COLOR_BLUE)} ${StyleBold.render(projectDisplayName(lease.projectRoot))}  ${StyleDim.render(pidStr)}  ${StyleDim.render(`age=${age}`)}`,
    );
  }
  return lines.length > 0 ? lines : [StyleDim.render("(no clients)")];
}

function jobsTitle(summary: PsSummary, opts: PsOptions): string {
  let title = `Jobs — ${summary.runningJobs} running · ${summary.queuedJobs} queued · ${summary.recentJobs} recent`;
  if (summary.failedJobs > 0) title += ` · ${summary.failedJobs} failed`;
  if (opts.failedOnly) title += " · failed only";
  if (!opts.all && opts.tail > 0) title += ` · tail ${opts.tail}`;
  if (opts.all) title += " · all";
  return title;
}

function jobDetailLines(snapshots: ProjectSnapshot[], opts: PsOptions, styled: boolean): string[] {
  const lines: string[] = [];
  const now = nowNs();
  const kindW = 14;
  let targetW = 40;
  const tw = terminalWidth();
  if (tw > 0) {
    targetW = tw - 65;
    if (targetW < 24) targetW = 24;
    if (targetW > 72) targetW = 72;
  }
  const mark = (label: string, status: string): string => {
    if (!styled) return label;
    switch (status) {
      case "running":
        return StyleInfo.render(label);
      case "queued":
        return StyleDim.render(label);
      case "fail":
        return StyleError.render(label);
      default:
        return StyleSuccess.render(label);
    }
  };
  const detailStyle = (v: string) => (styled ? StyleDim.render(v) : v);

  if (!opts.failedOnly) {
    for (const snap of snapshots) {
      const project = projectDisplayName(snap.root);
      for (const job of snap.running) {
        const dur = job.startedAt ? durString(roundNs(now - timeNs(job.startedAt), SECOND)) : "";
        let progress = `running=${dur}`;
        const total = job.total ?? 0;
        if (total > 0) {
          const processed = job.processed ?? 0;
          const pct = Math.trunc((processed * 100) / total);
          const phase = job.phase || "working";
          progress = `${phase} ${processed}/${total} (${pct}%) ${dur}`;
        } else if (job.phase) {
          progress = `${job.phase} ${dur}`;
        }
        lines.push(
          `${mark("▶", "running")}  ${padRight(job.kind, kindW)}  ${padRight(
            shortenTarget(`${project}/${job.target ?? ""}`, targetW),
            targetW,
          )}  ${detailStyle(progress)}`,
        );
      }
      for (const job of snap.queued) {
        const wait = durString(roundNs(now - timeNs(job.requestedAt), SECOND));
        lines.push(
          `${mark("⋯", "queued")}  ${padRight(job.kind, kindW)}  ${padRight(
            shortenTarget(`${project}/${job.target ?? ""}`, targetW),
            targetW,
          )}  ${detailStyle(`queued=${wait}`)}`,
        );
      }
    }
  }

  for (const row of recentRows(snapshots, opts)) {
    const result = row.result;
    let status = "ok";
    let glyph = "✓";
    let detail = "";
    if (!result.success) {
      status = "fail";
      glyph = "✗";
      detail = `  ${psErrorSummary(result.error ?? "")}`;
      const remediation = psRemediation(result.error ?? "");
      if (remediation) detail += `  run: ${remediation}`;
    }
    const dur = durString(
      roundNs(timeNs(result.completedAt) - timeNs(result.startedAt), MILLISECOND),
    );
    if (styled && !result.success) detail = `  ${StyleError.render(detail.trim())}`;
    lines.push(
      `${mark(glyph, status)}  ${padRight(result.kind, kindW)}  ${padRight(
        shortenTarget(`${row.project}/${result.target ?? ""}`, targetW),
        targetW,
      )}  ${detailStyle(padRight(dur, 9))}${detail}`,
    );
  }
  return lines;
}

function failureLines(failures: FailureSummary[], styled: boolean): string[] {
  const lines: string[] = [];
  for (const f of failures) {
    const prefix = styled ? StyleError.render("✗") : "✗";
    const target = f.target === "" ? "-" : f.target;
    const repeated = f.count > 1 ? `  repeated ${f.count}x` : "";
    lines.push(
      `${prefix}  ${f.kind}  ${f.project}/${shortenTarget(target, 24)}${repeated}  ${f.error}`,
    );
    if (f.remediation) {
      const remediation = `Run: ${f.remediation}`;
      lines.push(`   ${styled ? StyleDim.render(remediation) : remediation}`);
    }
  }
  return lines;
}

function renderPsPlain(
  status: Status,
  snapshots: ProjectSnapshot[],
  summary: PsSummary,
  opts: PsOptions,
  semantic: SemanticRuntimeStatus,
  reload: ReloadStatus,
): string {
  let out = "";
  const state = status.running ? "running" : "stopped";
  out += `runtime\t${state}\tpid=${status.pid ?? 0}\tversion=${status.version ?? ""}\n`;
  for (const line of semanticRuntimePlainLines(semantic, reload)) out += `${line}\n`;
  for (const w of status.watchers ?? []) {
    out += `watcher\t${projectDisplayName(w.projectRoot)}\tdemand=${w.demand}\tstate=${watcherState(w)}`;
    if (w.gracePending && !isZeroTime(w.graceUntil))
      out += `\tuntil=${rfc3339(w.graceUntil as string)}`;
    out += "\n";
  }
  out += `activity\tclients=${summary.clients}\tprojects=${summary.projects}\trunning=${summary.runningJobs}\tqueued=${summary.queuedJobs}\trecent=${summary.recentJobs}\tfailed=${summary.failedJobs}\n`;

  let clientLimit = opts.clientLimit;
  if (clientLimit > status.clients.length) clientLimit = status.clients.length;
  if (clientLimit < 0) clientLimit = 0;
  for (let i = 0; i < status.clients.length; i++) {
    const lease = status.clients[i] as Lease;
    if (i >= clientLimit) {
      if (clientLimit > 0) out += `clients-more\tcount=${status.clients.length - clientLimit}\n`;
      break;
    }
    const age = durString(roundNs(nowNs() - timeNs(lease.updatedAt), SECOND));
    out += `client\t${lease.clientKind}\t${projectDisplayName(lease.projectRoot)}\tpid=${lease.pid ?? 0}\tage=${age}\n`;
  }

  if (opts.showJobs) {
    const now = nowNs();
    if (!opts.failedOnly) {
      for (const snap of snapshots) {
        const project = projectDisplayName(snap.root);
        for (const job of snap.running) {
          const dur = job.startedAt ? durString(roundNs(now - timeNs(job.startedAt), SECOND)) : "";
          let progress = "";
          if ((job.total ?? 0) > 0)
            progress = `${job.phase ?? ""}=${job.processed ?? 0}/${job.total}`;
          else if (job.phase) progress = job.phase;
          out += `running\t${project}\t${job.kind}\t${shorten(job.target ?? "")}\t${dur}\t${progress}\n`;
        }
        for (const job of snap.queued) {
          const wait = durString(roundNs(now - timeNs(job.requestedAt), SECOND));
          out += `queued\t${project}\t${job.kind}\t${shorten(job.target ?? "")}\t${wait}\n`;
        }
      }
    }
    for (const row of recentRows(snapshots, opts)) {
      const mark = row.result.success ? "ok" : "fail";
      const dur = durString(
        roundNs(timeNs(row.result.completedAt) - timeNs(row.result.startedAt), MILLISECOND),
      );
      const errText = row.result.success ? "" : psErrorSummary(row.result.error ?? "");
      out += `recent\t${row.project}\t${row.result.kind}\t${shorten(row.result.target ?? "")}\t${mark}\t${dur}\t${errText}\n`;
    }
    return out;
  }

  for (const f of summary.failures) {
    const target = f.target === "" ? "-" : f.target;
    out += `failure\t${f.project}\t${f.kind}\t${target}\tcount=${f.count}\tduration=${f.lastDuration}\terror=${f.error}\n`;
    if (f.remediation) out += `remediation\t${f.remediation}\n`;
  }
  return out;
}

function renderPsStyled(
  status: Status,
  svc: ServiceStatus[],
  snapshots: ProjectSnapshot[],
  summary: PsSummary,
  opts: PsOptions,
  semantic: SemanticRuntimeStatus,
  reload: ReloadStatus,
): string {
  let out = "";
  const tag = status.running ? StyleSuccess.render("● running") : StyleWarning.render("○ stopped");
  out += `${StyleBold.render("Runtime")}  ${tag}  ${StyleDim.render(`pid=${status.pid ?? 0}  ${status.version ?? ""}`)}\n\n`;

  const servicesLines = serviceSummaryLines(svc);
  out += `${renderBox(`Services (${servicesLines.length})`, servicesLines)}\n\n`;
  out += `${renderBox("Semantic runtime", semanticRuntimeLines(semantic, reload, true))}\n\n`;
  const watchers = status.watchers ?? [];
  if (watchers.length > 0) {
    out += `${renderBox(`Knowledge watchers (${watchers.length})`, watcherLines(watchers))}\n\n`;
  }
  if (status.clients.length > 0 && opts.clientLimit > 0) {
    out += `${renderBox(`Clients (${status.clients.length})`, clientLines(status.clients, opts.clientLimit))}\n\n`;
  }

  const activity = [
    `Clients   ${summary.clients}`,
    `Running   ${summary.runningJobs}`,
    `Queued    ${summary.queuedJobs}`,
  ];
  let recentLine = `Recent    ${summary.recentJobs} total`;
  if (summary.failedJobs > 0) recentLine += StyleError.render(`  ${summary.failedJobs} failed`);
  activity.push(recentLine);
  out += `${renderBox("Activity", activity)}\n`;

  if (opts.showJobs) {
    let jobLines = jobDetailLines(snapshots, opts, true);
    if (jobLines.length === 0) jobLines = [StyleDim.render("(no matching jobs)")];
    out += `\n${renderBox(jobsTitle(summary, opts), jobLines)}\n`;
    return out;
  }
  if (summary.failures.length > 0) {
    out += `\n${renderBox("Recent failures", failureLines(summary.failures, true))}\n`;
  }
  out += `\n${renderBox("Use", [
    "knowns runtime ps --jobs --tail 20       show recent job detail",
    "knowns runtime ps --failed              show recent failures only",
    "knowns runtime ps --clients 10 --failures 5  tune compact limits",
    "knowns doctor --scope runtime,search    diagnose with remediation",
  ])}\n`;
  return out;
}

function snapshotJson(s: ProjectSnapshot): unknown {
  return {
    root: s.root,
    running: s.running.length > 0 ? s.running.map(jobJson) : null,
    queued: s.queued.length > 0 ? s.queued.map(jobJson) : null,
    recent: s.recent.map(resultJson),
  };
}

function summaryJson(s: PsSummary): unknown {
  return {
    clients: s.clients,
    projects: s.projects,
    runningJobs: s.runningJobs,
    queuedJobs: s.queuedJobs,
    recentJobs: s.recentJobs,
    failedJobs: s.failedJobs,
    ...(s.failures.length > 0
      ? {
          failures: s.failures.map((f) => ({
            project: f.project,
            kind: f.kind,
            ...(f.target ? { target: f.target } : {}),
            error: f.error,
            count: f.count,
            ...(f.lastDuration ? { lastDuration: f.lastDuration } : {}),
            ...(f.remediation ? { remediation: f.remediation } : {}),
          })),
        }
      : {}),
  };
}

async function projectStore(ctx: Ctx): Promise<Store | undefined> {
  try {
    return await getStoreErr(ctx.cmd);
  } catch {
    return undefined;
  }
}

function safeReloadStatus(): ReloadStatus {
  try {
    return loadReloadStatus();
  } catch {
    return { success: false };
  }
}

// --- commands -------------------------------------------------------------------------------------

export const runtimePsCommand = defineCommand({
  use: "ps",
  short: "Show live runtime processes and jobs, not readiness or integration status",
  long: `Show live shared runtime status: managed services, connected clients,
current queue activity, and bounded recent job failures.

Use this for process and queue visibility. For project readiness, use knowns status.
For diagnostics and remediation, use knowns doctor. For runtime hook or plugin
installation state, use knowns runtime status. For raw logs, use knowns runtime logs.`,
  flags: [
    { type: "bool", name: "watch", shorthand: "w", usage: "Refresh continuously", default: false },
    {
      type: "duration",
      name: "interval",
      usage: "Refresh interval when --watch is set",
      default: 2_000_000_000,
    },
    { type: "bool", name: "jobs", usage: "Show detailed runtime job history", default: false },
    {
      type: "int",
      name: "tail",
      usage: "Number of recent jobs to show when job details are enabled",
      default: 10,
    },
    { type: "bool", name: "failed", usage: "Show only failed recent jobs", default: false },
    { type: "bool", name: "all", usage: "Show all retained recent jobs", default: false },
    {
      type: "int",
      name: "clients",
      usage: "Number of connected clients to show in compact output (0 hides client rows)",
      default: DEFAULT_CLIENT_LIMIT,
    },
    {
      type: "int",
      name: "failures",
      usage: "Number of grouped recent failures to show in compact output (0 hides failure rows)",
      default: DEFAULT_FAILURE_LIMIT,
    },
  ],
  async run(ctx) {
    const watch = ctx.flags.bool("watch");
    let intervalNs = (ctx.cmd.flag("interval")?.value.get() as number) ?? 2_000_000_000;
    if (intervalNs <= 0) intervalNs = 2_000_000_000;

    const renderOnce = async (): Promise<void> => {
      const status = loadStatus();
      const opts = psOptions(ctx);
      const snapshots = collectProjectJobs(status);
      const summary = summarize(status, snapshots, opts.failureLimit);
      const semantic = observedSemanticRuntimeStatus(ctx.env);
      const reload = safeReloadStatus();

      if (ctx.json) {
        const services = detectAllServices(await projectStore(ctx), ctx.env);
        // A Go map: keys come out sorted.
        ctx.printJSON({
          options: opts,
          projects: snapshots.map(snapshotJson),
          reload: reloadJson(reload),
          semantic: semanticStatusJson(semantic),
          services: services.map(serviceJson),
          status: statusJson(status),
          summary: summaryJson(summary),
        });
        return;
      }
      if (watch) ctx.print("\x1b[2J\x1b[H");
      if (ctx.plain) {
        ctx.print(renderPsPlain(status, snapshots, summary, opts, semantic, reload));
        return;
      }
      const services = detectAllServices(await projectStore(ctx), ctx.env);
      ctx.print(renderPsStyled(status, services, snapshots, summary, opts, semantic, reload));
    };

    if (!watch) return renderOnce();
    for (;;) {
      await renderOnce();
      await new Promise((r) => setTimeout(r, Math.max(1, intervalNs / 1e6)));
    }
  },
});

export const runtimeReloadCommand = defineCommand({
  use: "reload",
  short: "Reload shared runtime semantic providers and config",
  flags: [
    { type: "bool", name: "wait", usage: "Wait until runtime acknowledges reload", default: false },
    {
      type: "duration",
      name: "timeout",
      usage: "Maximum time to wait for reload acknowledgement",
      default: 10_000_000_000,
    },
  ],
  async run(ctx) {
    const wait = ctx.flags.bool("wait");
    const timeoutMs = ((ctx.cmd.flag("timeout")?.value.get() as number) ?? 10_000_000_000) / 1e6;
    const status = loadStatus();
    const running = status.running && isRunning();
    let semantic = observedSemanticRuntimeStatus(ctx.env);
    let readiness: SemanticIndexReadiness | undefined;
    const store = await projectStore(ctx);
    if (store) {
      readiness = resolveSemanticIndexReadiness(
        createStorage(store),
        buildSearchEnvironment({ env: ctx.env }),
      );
    }
    const remediation = readiness ? semanticReindexRemediation(readiness) : "";

    if (!running) {
      if (ctx.json) {
        ctx.printJSON({
          acknowledged: false,
          noop: true,
          readiness: readinessJson(readiness),
          remediation,
          requested: false,
          running: false,
          semantic: semanticStatusJson(semantic),
        });
        return;
      }
      if (ctx.plain) {
        let out = "reload\tnoop\trunning=false\tacknowledged=false\n";
        for (const line of semanticRuntimePlainLines(semantic, { success: false }))
          out += `${line}\n`;
        if (readiness) out += `${readinessPlainLine(readiness)}\n`;
        if (remediation) out += `remediation\t${remediation}\n`;
        ctx.print(out);
        return;
      }
      let out = `${StyleDim.render("Runtime is not running; no reload request was needed.")}\n`;
      out += `${StyleDim.render("The next runtime start, job, or search will read the latest semantic settings.")}\n`;
      for (const line of readinessLines(readiness, true)) out += `${line}\n`;
      ctx.print(out);
      return;
    }

    const request: ReloadRequest = requestReload();
    let reload: ReloadStatus = { success: false };
    let acknowledged = false;
    if (wait) {
      reload = await waitForReload(request.id, timeoutMs);
      acknowledged = true;
      semantic = observedSemanticRuntimeStatus(ctx.env);
    } else {
      try {
        const loaded = loadReloadStatus();
        if (loaded.requestId === request.id) {
          reload = loaded;
          acknowledged = loaded.success === true;
        }
      } catch {
        // no status yet
      }
    }

    if (ctx.json) {
      ctx.printJSON({
        acknowledged,
        noop: false,
        pid: status.pid ?? 0,
        readiness: readinessJson(readiness),
        reload: reloadJson(reload),
        remediation,
        request: {
          id: request.id,
          requestedAt: goTimeString(request.requestedAt),
          ...(request.pid ? { pid: request.pid } : {}),
        },
        requested: true,
        running: true,
        semantic: semanticStatusJson(semantic),
      });
      return;
    }
    if (ctx.plain) {
      let out = `reload\trequested\trunning=true\tpid=${status.pid ?? 0}\trequestId=${request.id}\tacknowledged=${acknowledged}\n`;
      if (acknowledged) {
        out += `reload-ack\tgeneration=${reload.generation ?? 0}\tprocessedAt=${rfc3339(reload.processedAt || GO_ZERO)}\trequestId=${reload.requestId ?? ""}\n`;
      }
      for (const line of semanticRuntimePlainLines(semantic, reload)) out += `${line}\n`;
      if (readiness) out += `${readinessPlainLine(readiness)}\n`;
      if (remediation) out += `remediation\t${remediation}\n`;
      ctx.print(out);
      return;
    }
    let out: string;
    if (acknowledged) {
      out = `${StyleSuccess.render("✓")} Runtime reload acknowledged by daemon pid=${status.pid ?? 0}.\n`;
      out += `${StyleDim.render("Reload")} generation=${reload.generation ?? 0} request=${reload.requestId ?? ""}\n`;
    } else {
      out = `${StyleSuccess.render("✓")} Runtime reload requested for daemon pid=${status.pid ?? 0}.\n`;
      out += `${StyleDim.render("Reload")} request=${request.id}; use --wait to block until acknowledged.\n`;
    }
    out += `\n${renderBox("Semantic runtime", semanticRuntimeLines(semantic, reload, true))}\n`;
    for (const line of readinessLines(readiness, true)) out += `${line}\n`;
    ctx.print(out);
  },
});

// --- logs -----------------------------------------------------------------------------------------

/** tailFile: the last n lines (default 50) as bufio.Scanner would split them. */
function tailFile(path: string, n: number): string {
  const count = n <= 0 ? 50 : n;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines
    .slice(-count)
    .map((l) => `${l.endsWith("\r") ? l.slice(0, -1) : l}\n`)
    .join("");
}

interface TailState {
  name: string;
  path: string;
  fd: number;
  size: number;
}

async function followFiles(ctx: Ctx, paths: Array<{ name: string; path: string }>): Promise<void> {
  const states: TailState[] = [];
  for (const p of paths) {
    try {
      const fd = openSync(p.path, "r");
      states.push({ name: p.name, path: p.path, fd, size: fstatSync(fd).size });
    } catch {
      // skip unreadable
    }
  }
  const prefix = states.length > 1;
  const buf = Buffer.alloc(32 * 1024);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      for (const s of states) {
        let info: ReturnType<typeof statSync>;
        try {
          info = statSync(s.path);
        } catch {
          continue;
        }
        if (info.size < s.size) s.size = 0;
        for (;;) {
          const n = readSync(s.fd, buf, 0, buf.length, s.size);
          if (n <= 0) break;
          s.size += n;
          const chunk = buf.subarray(0, n).toString();
          if (prefix) {
            for (const line of chunk.split(/(?<=\n)/)) {
              if (line === "") continue;
              ctx.print(`${StyleDim.render(`[${s.name}]`)} ${line}`);
            }
          } else {
            ctx.print(chunk);
          }
        }
      }
    }
  } finally {
    for (const s of states) closeSync(s.fd);
  }
}

export const runtimeLogsCommand = defineCommand({
  use: "logs",
  short: "Show runtime / MCP server log files",
  flags: [
    { type: "bool", name: "follow", shorthand: "f", usage: "Follow new log lines", default: false },
    {
      type: "int",
      name: "tail",
      shorthand: "n",
      usage: "Number of trailing lines to show",
      default: 50,
    },
    {
      type: "string",
      name: "source",
      shorthand: "s",
      usage: "Which log to read: runtime|mcp|all",
      default: "all",
    },
  ],
  async run(ctx) {
    const follow = ctx.flags.bool("follow");
    const tailN = ctx.flags.int("tail");
    const source = ctx.flags.string("source");

    const paths: Array<{ name: string; path: string }> = [];
    switch (source) {
      case "runtime":
        paths.push({ name: "runtime", path: runtimeLogPath() });
        break;
      case "mcp":
        paths.push({ name: "mcp", path: mcpLogPath() });
        break;
      case "":
      case "all":
        paths.push(
          { name: "runtime", path: runtimeLogPath() },
          { name: "mcp", path: mcpLogPath() },
        );
        break;
      default:
        throw new Error(`unknown --source "${source}" (want runtime|mcp|all)`);
    }

    for (const p of paths) {
      let missing = false;
      try {
        statSync(p.path);
      } catch (err) {
        missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (missing) {
        ctx.print(`${StyleDim.render("·")} ${p.path} (no log yet)\n`);
        continue;
      }
      if (!ctx.plain) {
        ctx.print(`${renderBadge(p.name.toUpperCase(), COLOR_BLUE)} ${StyleDim.render(p.path)}\n`);
      }
      ctx.print(tailFile(p.path, tailN));
    }
    if (follow) await followFiles(ctx, paths);
  },
});
