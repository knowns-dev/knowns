// The persisted shape of store sync (internal/storesync/service.go StoreState and
// resolve.go Resolution). Both files are shared with Go 0.34.1 when the runtime changes hands, so
// the JSON is written exactly as encoding/json does: struct field order, time.Time always present
// (the zero time as 0001-01-01T00:00:00Z), omitempty fields dropped, two-space indent.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { goJsonStringify } from "../../storage/core/util.ts";
import { goNow } from "../../storage/history/go-json.ts";

export const ZERO_TIME = "0001-01-01T00:00:00Z";

/** A time.Time: kept as its RFC 3339 text so a state file round-trips without losing precision. */
export type GoTime = string;

export const isZeroTime = (t: GoTime | undefined): boolean =>
  t === undefined || t === "" || t === ZERO_TIME;

/** time.Time.UTC() marshalled by encoding/json. */
export const timeText = (d: Date): GoTime => goNow(d);

/** Milliseconds since epoch of a Go-written time (nanosecond digits are cut to three). */
export function timeMs(t: GoTime): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(t);
  if (!m) return Number.NaN;
  const frac = `${m[2] ?? ""}000`.slice(0, 3);
  return Date.parse(`${m[1]}.${frac}${m[3]}`);
}

export interface Conflict {
  project: string;
  paths: string[];
  since: GoTime;
  /** The upstream commit whose version of paths is in history. */
  remote: string;
}

export interface StoreState {
  store: string;
  clone: string;
  remote: string;
  projects: string[];
  lastCommit: GoTime;
  lastPush: GoTime;
  lastFetch: GoTime;
  queuedCommits: number;
  paused: boolean;
  pauseCause: string;
  pauseMessage: string;
  pausedSince: GoTime;
  pushRejected: boolean;
  diverged: boolean;
  conflicts: Conflict[];
  lastError: string;
  updatedAt: GoTime;
}

export function emptyState(store: string): StoreState {
  return {
    store,
    clone: "",
    remote: "",
    projects: [],
    lastCommit: ZERO_TIME,
    lastPush: ZERO_TIME,
    lastFetch: ZERO_TIME,
    queuedCommits: 0,
    paused: false,
    pauseCause: "",
    pauseMessage: "",
    pausedSince: ZERO_TIME,
    pushRejected: false,
    diverged: false,
    conflicts: [],
    lastError: "",
    updatedAt: ZERO_TIME,
  };
}

/** The Go struct order with its omitempty rules. */
export function stateForJson(s: StoreState): Record<string, unknown> {
  const out: Record<string, unknown> = { store: s.store, clone: s.clone };
  if (s.remote !== "") out.remote = s.remote;
  out.projects = s.projects;
  out.lastCommit = s.lastCommit;
  out.lastPush = s.lastPush;
  out.lastFetch = s.lastFetch;
  out.queuedCommits = s.queuedCommits;
  out.paused = s.paused;
  if (s.pauseCause !== "") out.pauseCause = s.pauseCause;
  if (s.pauseMessage !== "") out.pauseMessage = s.pauseMessage;
  out.pausedSince = s.pausedSince;
  if (s.pushRejected) out.pushRejected = true;
  if (s.diverged) out.diverged = true;
  if (s.conflicts.length > 0) {
    out.conflicts = s.conflicts.map((c) => ({
      project: c.project,
      paths: c.paths,
      since: c.since,
      remote: c.remote,
    }));
  }
  if (s.lastError !== "") out.lastError = s.lastError;
  out.updatedAt = s.updatedAt;
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (v: unknown): GoTime => (typeof v === "string" && v !== "" ? v : ZERO_TIME);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** LoadState reads the persisted state of a store; throws when the file is missing or invalid. */
export function loadState(stateDir: string, store: string): StoreState {
  const raw: unknown = JSON.parse(readFileSync(join(stateDir, `${store}.json`), "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("json: cannot unmarshal into StoreState");
  }
  const o = raw as Record<string, unknown>;
  const conflicts: Conflict[] = Array.isArray(o.conflicts)
    ? (o.conflicts as unknown[]).flatMap((c) => {
        if (c === null || typeof c !== "object") return [];
        const r = c as Record<string, unknown>;
        return [
          {
            project: str(r.project),
            paths: strs(r.paths),
            since: time(r.since),
            remote: str(r.remote),
          },
        ];
      })
    : [];
  return {
    store: str(o.store),
    clone: str(o.clone),
    remote: str(o.remote),
    projects: strs(o.projects),
    lastCommit: time(o.lastCommit),
    lastPush: time(o.lastPush),
    lastFetch: time(o.lastFetch),
    queuedCommits: typeof o.queuedCommits === "number" ? o.queuedCommits : 0,
    paused: o.paused === true,
    pauseCause: str(o.pauseCause),
    pauseMessage: str(o.pauseMessage),
    pausedSince: time(o.pausedSince),
    pushRejected: o.pushRejected === true,
    diverged: o.diverged === true,
    conflicts,
    lastError: str(o.lastError),
    updatedAt: time(o.updatedAt),
  };
}

/** persist: temp file then rename, so a reader never sees half a state file. */
export function persistState(stateDir: string, state: StoreState): void {
  if (stateDir === "") return;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    const tmp = join(stateDir, `.${state.store}.json.tmp`);
    writeFileSync(tmp, `${goJsonStringify(stateForJson(state))}\n`, { mode: 0o644 });
    renameSync(tmp, join(stateDir, `${state.store}.json`));
  } catch {
    // Go ignores persistence failures; the next tick writes again
  }
}

// --- resolutions (resolve.go) ---------------------------------------------------------------

/**
 * Resolution marks conflicting paths of a paused project as settled by the user. Resolvers never
 * edit the runtime's state file: they append a Resolution, and the runtime applies it next tick.
 */
export interface Resolution {
  project: string;
  paths: string[];
  resolvedAt?: GoTime;
}

export const resolutionsPath = (stateDir: string, store: string): string =>
  join(stateDir, `${store}.resolved.json`);

/** RecordResolution queues a resolution for the runtime to apply. */
export function recordResolution(stateDir: string, store: string, r: Resolution): void {
  const entry = {
    project: r.project,
    paths: r.paths,
    resolvedAt: r.resolvedAt ?? timeText(new Date()),
  };
  let pending: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolutionsPath(stateDir, store), "utf8"));
    if (Array.isArray(parsed)) pending = parsed;
  } catch {
    // an unreadable file starts a new queue, as in Go
  }
  pending.push(entry);
  mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  const path = resolutionsPath(stateDir, store);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${goJsonStringify(pending)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

/** readResolutions: the queued resolutions, or undefined when there is no file. Throws when unreadable. */
export function readResolutions(path: string): Resolution[] | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("json: cannot unmarshal into []Resolution");
  return parsed.flatMap((r) => {
    if (r === null || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    return [{ project: str(o.project), paths: strs(o.paths) }];
  });
}

export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
