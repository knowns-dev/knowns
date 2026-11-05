// Port of internal/storesync/service.go and rebase.go: keeps knowledge store clones in sync with
// their remotes from inside the shared runtime (store spec D3). Every Git decision, state field and
// message follows the Go service so Go and TypeScript can alternate on one linked store.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { goLogf } from "../../runtime/queue.ts";
import { globalRootPath } from "../../storage/core/global-root.ts";
import { withSyncLocks } from "../../storage/core/locks.ts";
import { MachineRegistry } from "../../storage/core/machine-registry.ts";
import { ensureStoreGitignore } from "../../storage/core/store-clone.ts";
import { recordSyncArrivals, type SyncArrival } from "../../storage/history/sync-provenance.ts";
import { classifyFailure, DEFAULT_GIT_TIMEOUT_MS, git } from "./git.ts";
import {
  type Conflict,
  emptyState,
  loadState,
  persistState,
  readResolutions,
  removeQuietly,
  resolutionsPath,
  type StoreState,
  timeText,
  ZERO_TIME,
} from "./state.ts";

// Store spec D3 intervals.
export const DEFAULT_DEBOUNCE_MS = 3000;
export const DEFAULT_FETCH_INTERVAL_MS = 30_000;
export const DEFAULT_TICK_MS = 1000;

// Pause causes recorded in StoreState.pauseCause.
export const PAUSE_CREDENTIALS = "credentials";
export const PAUSE_PUSH_CONTENTION = "push-contention";

/** maxPushAttempts bounds optimistic push retries in one cycle (FR-8). */
const MAX_PUSH_ATTEMPTS = 3;

export interface Config {
  /** The machine registry listing store-linked projects. */
  registryPath: string;
  /** Receives one <store>.json state file per store. */
  stateDir: string;
  debounceMs: number;
  fetchIntervalMs: number;
  tickMs: number;
  gitTimeoutMs: number;
  now: () => Date;
  /**
   * Receives, per project folder, the paths (relative to that folder) that arrived through an
   * integration, so they can be reconciled into local history and reindexed (FR-20). Called
   * without sync locks held.
   */
  onSynced?: (
    signal: AbortSignal,
    knowledgeRoot: string,
    relPaths: string[],
  ) => Promise<void> | void;
}

function durationFromEnv(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  if (raw !== "") {
    const ms = Number.parseInt(raw, 10);
    if (/^[+-]?\d+$/.test(raw) && ms > 0) return ms;
  }
  return fallback;
}

/** DefaultConfig: the machine registry and the given runtime state directory with the D3 intervals. */
export function defaultConfig(stateDir: string): Config {
  return {
    registryPath: join(globalRootPath(), "registry.json"),
    stateDir,
    debounceMs: durationFromEnv("KNOWNS_STORE_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS),
    fetchIntervalMs: durationFromEnv("KNOWNS_STORE_FETCH_INTERVAL_MS", DEFAULT_FETCH_INTERVAL_MS),
    tickMs: DEFAULT_TICK_MS,
    gitTimeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    now: () => new Date(),
  };
}

interface StoreRuntime {
  state: StoreState;
  changeSig: string;
  lastChangeAt: number | undefined;
  nextFetch: number;
  /** Consecutive rejected pushes across attempts. */
  rejections: number;
  /** The lastError the tick catch recorded for an unexpected throw (TS only). */
  unexpected?: string | undefined;
}

export interface FoundStore {
  store: string;
  clone: string;
  remote: string;
  projects: string[];
}

/** discoverStores groups the registry's store-linked projects by store. */
export function discoverStores(registryPath: string): FoundStore[] {
  const reg = new MachineRegistry(registryPath);
  try {
    reg.loadReadOnly();
  } catch {
    return [];
  }
  const byName = new Map<string, FoundStore>();
  for (const p of reg.projects) {
    if (!p.store) continue;
    let fs = byName.get(p.store.name);
    if (!fs) {
      fs = {
        store: p.store.name,
        clone: join(reg.storesRoot(), p.store.name),
        remote: p.store.remote ?? "",
        projects: [],
      };
      byName.set(p.store.name, fs);
    }
    fs.projects.push(p.store.project);
  }
  return [...byName.keys()].sort().map((name) => {
    const found = byName.get(name) as FoundStore;
    found.projects.sort();
    return found;
  });
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** statusPath: the path of one `git status --porcelain` line. */
export function statusPath(line: string): string {
  if (line.length < 4) return "";
  let path = line.slice(3).trim();
  const i = path.indexOf(" -> ");
  if (i >= 0) path = path.slice(i + 4);
  return path.replace(/^"+|"+$/g, "");
}

const toSlash = (p: string): string => (sep === "\\" ? p.replaceAll("\\", "/") : p);

function changedProjects(status: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of status.split("\n")) {
    const path = statusPath(line);
    if (path === "") continue;
    const project = toSlash(path).split("/")[0] as string;
    if (!seen.has(project)) {
      seen.add(project);
      out.push(project);
    }
  }
  return out.sort();
}

export const firstLine = (s: string): string => {
  const t = s.trim();
  const i = t.indexOf("\n");
  return i >= 0 ? t.slice(0, i) : t;
};

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

const goQuote = (s: string): string => JSON.stringify(s);

/** Splits "<project>/<rest>" like strings.SplitN(ToSlash(p), "/", 2). */
function splitProject(p: string): [string, string | undefined] {
  const s = toSlash(p);
  const i = s.indexOf("/");
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

function groupByProject(paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const [project, rest] = splitProject(p);
    if (rest === undefined) continue;
    const list = out.get(project) ?? [];
    list.push(rest);
    out.set(project, list);
  }
  return out;
}

/** Service syncs every store clone the registry links to. */
export class Service {
  private readonly stores = new Map<string, StoreRuntime>();
  /** Lets tests simulate another machine winning the push race. */
  beforePush: (() => void | Promise<void>) | undefined;
  private signal: AbortSignal = new AbortController().signal;

  constructor(readonly cfg: Config) {
    if (cfg.debounceMs <= 0) cfg.debounceMs = DEFAULT_DEBOUNCE_MS;
    if (cfg.fetchIntervalMs <= 0) cfg.fetchIntervalMs = DEFAULT_FETCH_INTERVAL_MS;
    if (cfg.tickMs <= 0) cfg.tickMs = DEFAULT_TICK_MS;
  }

  /** Run syncs until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await this.tick(signal);
      } catch (e) {
        // Not in Go, where a panic kills the runtime loudly. Here the daemon keeps running (keepAlive
        // holds it up while stores are linked), so a throw must be logged and the loop must go on,
        // or sync stops forever while the daemon looks healthy.
        goLogf(`[storesync] sync pass failed: ${(e as Error).message}`);
      }
      if (signal.aborted) return;
      await sleep(this.cfg.tickMs, signal);
      if (signal.aborted) return;
    }
  }

  /** HasStores: whether the last tick found any linked store; keeps the runtime alive with no client. */
  hasStores = (): boolean => {
    if (discoverStores(this.cfg.registryPath).length > 0) return true;
    return this.stores.size > 0;
  };

  /** Tick runs one pass over every linked store. */
  async tick(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    for (const found of discoverStores(this.cfg.registryPath)) {
      if (signal.aborted) return;
      let rt = this.stores.get(found.store);
      if (!rt) {
        rt = {
          state: this.restoredState(found.store),
          changeSig: "",
          lastChangeAt: undefined,
          nextFetch: 0,
          rejections: 0,
        };
        this.stores.set(found.store, rt);
      }
      rt.state.clone = found.clone;
      rt.state.remote = found.remote;
      rt.state.projects = found.projects;
      try {
        this.applyResolutions(rt);
        await this.syncStore(rt);
        // A pass that completes clears an error only this catch recorded (Go has no such error;
        // its own paths set and clear lastError themselves).
        if (rt.unexpected !== undefined && rt.state.lastError === rt.unexpected) {
          rt.state.lastError = "";
        }
        rt.unexpected = undefined;
      } catch (e) {
        // One store's unexpected failure must not skip the stores after it in this pass.
        rt.state.lastError = (e as Error).message;
        rt.unexpected = rt.state.lastError;
        goLogf(`[storesync] store ${goQuote(rt.state.store)}: ${rt.state.lastError}`);
      }
      rt.state.updatedAt = timeText(this.cfg.now());
      this.persist(rt.state);
    }
  }

  /**
   * restoredState starts a store from its persisted state, so conflicts and pauses survive a
   * runtime restart: a project paused by a conflict must never resume committing its local
   * content just because the daemon restarted.
   */
  private restoredState(store: string): StoreState {
    const state = emptyState(store);
    if (this.cfg.stateDir === "") return state;
    let persisted: StoreState;
    try {
      persisted = loadState(this.cfg.stateDir, store);
    } catch {
      return state;
    }
    state.conflicts = persisted.conflicts;
    state.paused = persisted.paused;
    state.pauseCause = persisted.pauseCause;
    state.pauseMessage = persisted.pauseMessage;
    state.pausedSince = persisted.pausedSince;
    state.lastCommit = persisted.lastCommit;
    state.lastPush = persisted.lastPush;
    state.lastFetch = persisted.lastFetch;
    return state;
  }

  /** State returns the current state of a store, if known. */
  state(store: string): StoreState | undefined {
    return this.stores.get(store)?.state;
  }

  private persist(state: StoreState): void {
    persistState(this.cfg.stateDir, state);
  }

  // --- git helpers --------------------------------------------------------------------------

  private git(dir: string, ...args: string[]): Promise<string> {
    return git(this.signal, dir, this.cfg.gitTimeoutMs, undefined, ...args);
  }

  private gitWithEnv(dir: string, env: string[] | undefined, ...args: string[]): Promise<string> {
    return git(this.signal, dir, this.cfg.gitTimeoutMs, env, ...args);
  }

  /** A git call whose failure the caller ignores (Go's `_, _ = s.git(...)`). */
  private async tryGit(dir: string, ...args: string[]): Promise<string | undefined> {
    try {
      return await this.git(dir, ...args);
    } catch {
      return undefined;
    }
  }

  private async hasUpstream(clone: string): Promise<boolean> {
    return (
      (await this.tryGit(clone, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")) !==
      undefined
    );
  }

  private async count(clone: string, rangeSpec: string): Promise<number> {
    const out = await this.tryGit(clone, "rev-list", "--count", rangeSpec);
    if (out === undefined) return 0;
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  private async aheadCount(clone: string): Promise<number> {
    if (await this.hasUpstream(clone)) return this.count(clone, "@{u}..HEAD");
    return this.count(clone, "HEAD");
  }

  /** identityEnv supplies a commit identity only when the clone has none. */
  private async identityEnv(clone: string): Promise<string[] | undefined> {
    const out = await this.tryGit(clone, "config", "user.email");
    if (out !== undefined && out.trim() !== "") return undefined;
    let name = "knowns";
    try {
      const u = userInfo().username;
      if (u) name = u;
    } catch {
      // keep the default
    }
    const host = hostname() || "localhost";
    const email = `${name}@${host}`;
    return [
      `GIT_AUTHOR_NAME=${name}`,
      `GIT_AUTHOR_EMAIL=${email}`,
      `GIT_COMMITTER_NAME=${name}`,
      `GIT_COMMITTER_EMAIL=${email}`,
    ];
  }

  // --- sync ---------------------------------------------------------------------------------

  private async syncStore(rt: StoreRuntime): Promise<void> {
    const now = this.cfg.now().getTime();
    const clone = rt.state.clone;
    let isRepo = false;
    try {
      isRepo = statSync(join(clone, ".git")).isDirectory();
    } catch {
      isRepo = false;
    }
    if (!isRepo) {
      rt.state.lastError = `${clone} is not a Git clone`;
      return;
    }
    try {
      ensureStoreGitignore(clone);
    } catch (e) {
      rt.state.lastError = (e as Error).message;
      return;
    }

    // A store paused for credentials or push contention only retries on the fetch interval;
    // local commits keep accumulating meanwhile.
    const fetchDue = now >= rt.nextFetch;
    await this.commitWhenQuiet(rt, now);
    if (rt.state.paused && !fetchDue) {
      rt.state.queuedCommits = await this.aheadCount(clone);
      return;
    }

    if (fetchDue) {
      rt.nextFetch = now + this.cfg.fetchIntervalMs;
      if (!(await this.fetch(rt, now))) {
        rt.state.queuedCommits = await this.aheadCount(clone);
        return;
      }
      if (rt.state.paused && rt.state.pauseCause === PAUSE_CREDENTIALS) this.resume(rt);
    }
    // Integration needs no network: it runs every tick, so a fetch that arrived while local
    // changes were pending is applied once they commit.
    await this.integrate(rt);

    await this.pushWithRetry(rt, now);
    rt.state.queuedCommits = await this.aheadCount(clone);
  }

  private async fetch(rt: StoreRuntime, now: number): Promise<boolean> {
    try {
      await this.git(rt.state.clone, "fetch", "--prune", "origin");
    } catch (e) {
      if (!this.signal.aborted) this.remoteFailed(rt, "fetch", e as Error);
      return false;
    }
    rt.state.lastFetch = timeText(new Date(now));
    return true;
  }

  private async porcelain(clone: string, pathspec: string[]): Promise<string> {
    return this.git(clone, "status", "--porcelain", "--untracked-files=all", "--", ...pathspec);
  }

  /** syncedPathspec: every path of the clone except projects paused by a conflict. */
  private syncedPathspec(rt: StoreRuntime): string[] {
    return [".", ...rt.state.conflicts.map((c) => `:(exclude)${c.project}`)];
  }

  /** commitWhenQuiet commits the working tree once it has not changed for the debounce period. */
  private async commitWhenQuiet(rt: StoreRuntime, now: number): Promise<void> {
    const clone = rt.state.clone;
    const pathspec = this.syncedPathspec(rt);
    let status: string;
    try {
      status = await this.porcelain(clone, pathspec);
    } catch (e) {
      rt.state.lastError = (e as Error).message;
      return;
    }
    if (status.trim() === "") {
      rt.changeSig = "";
      rt.lastChangeAt = undefined;
      return;
    }
    const sig = changeSignature(clone, status);
    if (sig !== rt.changeSig) {
      rt.changeSig = sig;
      rt.lastChangeAt = now;
      return;
    }
    if (rt.lastChangeAt !== undefined && now - rt.lastChangeAt < this.cfg.debounceMs) return;
    try {
      await this.git(clone, "add", "-A", "--", ...pathspec);
    } catch (e) {
      rt.state.lastError = (e as Error).message;
      return;
    }
    const message = `knowns: sync ${changedProjects(status).join(", ")}`;
    try {
      await this.gitWithEnv(
        clone,
        await this.identityEnv(clone),
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        message,
      );
    } catch (e) {
      rt.state.lastError = (e as Error).message;
      return;
    }
    rt.state.lastCommit = timeText(new Date(now));
    rt.changeSig = "";
    rt.lastChangeAt = undefined;
  }

  private remoteFailed(rt: StoreRuntime, op: string, err: Error): void {
    const msg = err.message;
    switch (classifyFailure(msg)) {
      case "credential":
        if (!rt.state.paused || rt.state.pauseCause !== PAUSE_CREDENTIALS) {
          rt.state.pausedSince = timeText(this.cfg.now());
        }
        rt.state.paused = true;
        rt.state.pauseCause = PAUSE_CREDENTIALS;
        rt.state.pauseMessage = `store ${goQuote(rt.state.store)} paused: ${op} to ${rt.state.remote} was refused for lack of a working credential (Knowns uses your ssh-agent or Git credential helper and never prompts): ${firstLine(msg)}`;
        goLogf(`[storesync] ${rt.state.pauseMessage}`);
        break;
      case "rejected":
        rt.state.pushRejected = true;
        rt.state.lastError = firstLine(msg);
        break;
      default:
        rt.state.lastError = `${op} to ${rt.state.remote} failed, will retry: ${firstLine(msg)}`;
    }
  }

  private resume(rt: StoreRuntime): void {
    if (rt.state.paused) {
      rt.state.paused = false;
      rt.state.pauseCause = "";
      rt.state.pauseMessage = "";
      rt.state.pausedSince = ZERO_TIME;
    }
    rt.state.lastError = "";
  }

  // --- resolutions (resolve.go applyResolutions) ---------------------------------------------

  private applyResolutions(rt: StoreRuntime): void {
    if (this.cfg.stateDir === "") return;
    const path = resolutionsPath(this.cfg.stateDir, rt.state.store);
    let pending: ReturnType<typeof readResolutions>;
    try {
      pending = readResolutions(path);
    } catch (e) {
      rt.state.lastError = `unreadable resolutions file ${path}: ${(e as Error).message}`;
      return;
    }
    if (pending === undefined) return;
    for (const r of pending) {
      const resolved = new Set(r.paths);
      const kept: Conflict[] = [];
      for (const c of rt.state.conflicts) {
        if (c.project === r.project) {
          c.paths = c.paths.filter((p) => !resolved.has(p));
          if (c.paths.length === 0) continue;
        }
        kept.push(c);
      }
      rt.state.conflicts = kept;
    }
    rt.state.conflicts.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
    removeQuietly(path);
    this.persist(rt.state);
  }

  // --- integration (rebase.go) ----------------------------------------------------------------

  /** cleanForIntegration: nothing outside paused projects is waiting to be committed. */
  private async cleanForIntegration(rt: StoreRuntime): Promise<boolean> {
    try {
      return (await this.porcelain(rt.state.clone, this.syncedPathspec(rt))).trim() === "";
    } catch {
      return false;
    }
  }

  private async changedPaths(clone: string, rangeSpec: string): Promise<string[]> {
    const out = await this.tryGit(clone, "diff", "--name-only", rangeSpec);
    if (out === undefined) return [];
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }

  /**
   * integrate brings upstream into the clone: fast-forward when strictly behind, rebase local
   * commits when diverged. It holds the mutation locks of every entity the operation can rewrite,
   * checks for pending changes only under those locks, and sets paused projects' local content
   * aside and back inside them (D8, FR-11). Entities that arrived are then handed to onSynced for
   * reconciliation and indexing, after the locks are released (FR-20).
   */
  private async integrate(rt: StoreRuntime): Promise<boolean> {
    const clone = rt.state.clone;
    if (!(await this.hasUpstream(clone))) return true;
    const behind = await this.count(clone, "HEAD..@{u}");
    const ahead = await this.count(clone, "@{u}..HEAD");
    rt.state.diverged = behind > 0 && ahead > 0;
    if (behind === 0) return true;

    const incoming = await this.changedPaths(clone, "HEAD...@{u}");
    const touched = [...incoming];
    if (ahead > 0) touched.push(...(await this.changedPaths(clone, "@{u}...HEAD")));
    for (const c of rt.state.conflicts) {
      touched.push(...c.paths);
      const status = await this.tryGit(
        clone,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        c.project,
      );
      if (status !== undefined) {
        for (const line of status.split("\n")) {
          const p = statusPath(line);
          if (p !== "") touched.push(p);
        }
      }
    }

    let integrated = false;
    try {
      await this.withEntityLocks(clone, uniqueSorted(touched), async () => {
        if (!(await this.cleanForIntegration(rt))) return; // pending changes commit first
        const restore = await this.setAsidePaused(rt);
        try {
          if (ahead === 0) {
            await this.git(clone, "merge", "--ff-only", "--quiet", "@{u}");
            integrated = true;
            return;
          }
          integrated = await this.rebase(rt);
        } finally {
          restore();
        }
      });
    } catch (e) {
      rt.state.lastError = (e as Error).message;
      return false;
    }
    if (!integrated) return false;
    rt.state.diverged = false;
    await this.notifySynced(clone, incoming);
    return true;
  }

  /** withEntityLocks holds, project by project in sorted order, the locks every local mutation holds. */
  private async withEntityLocks(
    clone: string,
    paths: string[],
    fn: () => Promise<void>,
  ): Promise<void> {
    const byProject = groupByProject(paths);
    const projects = [...byProject.keys()].sort();
    const run = async (i: number): Promise<void> => {
      if (i === projects.length) return fn();
      const project = projects[i] as string;
      await withSyncLocks(join(clone, project), byProject.get(project) ?? [], () => run(i + 1));
    };
    await run(0);
  }

  /** notifySynced records who wrote each arrived file (FR-13) and hands the paths to onSynced. */
  private async notifySynced(clone: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.recordArrivals(clone, paths);
    const onSynced = this.cfg.onSynced;
    if (!onSynced) return;
    const byProject = groupByProject(paths);
    for (const project of [...byProject.keys()].sort()) {
      await onSynced(this.signal, join(clone, project), byProject.get(project) ?? []);
    }
  }

  private async recordArrivals(clone: string, paths: string[]): Promise<void> {
    const now = timeText(this.cfg.now());
    const byProject = new Map<string, Omit<SyncArrival, "contentSha">[]>();
    for (const p of paths) {
      const [project, rest] = splitProject(p);
      if (rest === undefined) continue;
      const out = await this.tryGit(clone, "log", "-1", "--format=%an <%ae>%x1f%H", "--", p);
      if (out === undefined) continue;
      const fields = out.trim().split("\x1f");
      const arrival: Omit<SyncArrival, "contentSha"> = {
        path: rest,
        author: fields[0] ?? "",
        arrivedAt: now,
        ...(fields.length > 1 ? { commit: fields.slice(1).join("\x1f") } : {}),
      };
      const list = byProject.get(project) ?? [];
      list.push(arrival);
      byProject.set(project, list);
    }
    for (const [project, arrivals] of byProject) {
      try {
        recordSyncArrivals(join(clone, project), arrivals);
      } catch (e) {
        goLogf(`[storesync] record arrivals for ${project}: ${(e as Error).message}`);
      }
    }
  }

  /** rebase replays local commits on upstream. A textual conflict pauses only the owning projects (D2). */
  private async rebase(rt: StoreRuntime): Promise<boolean> {
    const clone = rt.state.clone;
    const env = await this.identityEnv(clone);
    try {
      await this.gitWithEnv(clone, env, "rebase", "--quiet", "@{u}");
      return true;
    } catch (e) {
      if ((await this.conflictedPaths(clone)).length === 0) {
        await this.tryGit(clone, "rebase", "--abort");
        rt.state.lastError = (e as Error).message;
        return false;
      }
    }
    const conflicts = await this.conflictedPaths(clone);
    try {
      await this.git(clone, "rebase", "--abort");
    } catch (e) {
      rt.state.lastError = `rebase --abort: ${(e as Error).message}`;
      return false;
    }
    return this.pauseConflicts(rt, conflicts, env);
  }

  /**
   * pauseConflicts completes the rebase with upstream's version of every conflicting path in
   * history, puts the local content back in the working tree, and records the owning projects as
   * paused. Local content is never discarded: it stays in the working tree and a copy is saved
   * beside the runtime state.
   */
  private async pauseConflicts(
    rt: StoreRuntime,
    paths: string[],
    env: string[] | undefined,
  ): Promise<boolean> {
    const clone = rt.state.clone;
    const local = new Map<string, Buffer>();
    for (const p of paths) {
      try {
        local.set(p, readFileSync(join(clone, p)));
      } catch {
        // absent locally
      }
    }
    this.saveConflictCopies(rt.state.store, local);

    try {
      await this.gitWithEnv(clone, env, "rebase", "--quiet", "-X", "ours", "@{u}");
    } catch (e) {
      await this.tryGit(clone, "rebase", "--abort");
      rt.state.lastError = `rebase preferring upstream: ${(e as Error).message}`;
      return false;
    }
    const upstream = ((await this.tryGit(clone, "rev-parse", "@{u}")) ?? "").trim();
    for (const p of paths) {
      if ((await this.tryGit(clone, "cat-file", "-e", `@{u}:${p}`)) !== undefined) {
        await this.tryGit(clone, "checkout", "@{u}", "--", p);
      } else {
        await this.tryGit(clone, "rm", "--quiet", "--ignore-unmatch", "--", p);
      }
    }
    const staged = (await this.tryGit(clone, "diff", "--cached", "--name-only")) ?? "";
    if (staged.trim() !== "") {
      const msg = `knowns: keep remote version of ${paths.join(", ")} until resolved`;
      try {
        await this.gitWithEnv(clone, env, "commit", "--quiet", "--no-verify", "-m", msg);
      } catch (e) {
        rt.state.lastError = (e as Error).message;
        return false;
      }
    }
    for (const [p, data] of local) {
      try {
        mkdirSync(dirname(join(clone, p)), { recursive: true, mode: 0o755 });
        writeFileSync(join(clone, p), data, { mode: 0o644 });
      } catch {
        // Go ignores these errors
      }
    }
    for (const p of paths) {
      if (!local.has(p)) removeQuietly(join(clone, p));
    }
    this.recordConflicts(rt, paths, upstream);
    return true;
  }

  private recordConflicts(rt: StoreRuntime, paths: string[], upstream: string): void {
    const byProject = new Map<string, string[]>();
    for (const p of paths) {
      const project = toSlash(p).split("/")[0] as string;
      const list = byProject.get(project) ?? [];
      list.push(p);
      byProject.set(project, list);
    }
    const now = timeText(this.cfg.now());
    for (const [project, ps] of byProject) {
      let merged = false;
      for (const c of rt.state.conflicts) {
        if (c.project === project) {
          c.paths = uniqueSorted([...c.paths, ...ps]);
          c.remote = upstream;
          merged = true;
        }
      }
      if (!merged) {
        rt.state.conflicts.push({ project, paths: uniqueSorted(ps), since: now, remote: upstream });
      }
      goLogf(
        `[storesync] store ${goQuote(rt.state.store)} project ${goQuote(project)} paused by a conflict in ${ps.join(", ")}`,
      );
    }
    rt.state.conflicts.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  }

  /** setAsidePaused resets paused projects to HEAD for an integration and returns the put-back. */
  private async setAsidePaused(rt: StoreRuntime): Promise<() => void> {
    const clone = rt.state.clone;
    if (rt.state.conflicts.length === 0) return () => {};
    const saved = new Map<string, Buffer>();
    const removed: string[] = [];
    const putBack = () => {
      for (const [p, data] of saved) {
        try {
          mkdirSync(dirname(join(clone, p)), { recursive: true, mode: 0o755 });
          writeFileSync(join(clone, p), data, { mode: 0o644 });
        } catch {
          // ignored, as in Go
        }
      }
      for (const p of removed) removeQuietly(join(clone, p));
    };
    try {
      await this.resetPaused(rt, clone, saved, removed);
    } catch (e) {
      // Not in Go: a failure part-way (say a locked file on Windows for the second project)
      // would otherwise drop the first project's saved edits, which only live in `saved`.
      putBack();
      throw e;
    }
    return putBack;
  }

  private async resetPaused(
    rt: StoreRuntime,
    clone: string,
    saved: Map<string, Buffer>,
    removed: string[],
  ): Promise<void> {
    for (const c of rt.state.conflicts) {
      const status = await this.git(
        clone,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        c.project,
      );
      for (const line of status.split("\n")) {
        const p = statusPath(line);
        if (p === "") continue;
        try {
          saved.set(p, readFileSync(join(clone, p)));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") removed.push(p);
        }
      }
      await this.git(clone, "checkout", "HEAD", "--", c.project);
      await this.git(clone, "clean", "-fdq", "--", c.project);
    }
  }

  /**
   * pushWithRetry pushes optimistically; the remote's atomic non-fast-forward rejection is the
   * collision check (D7). A rejection fetches, integrates and retries, at most three times, then
   * pauses the store for push contention until the next fetch interval. It never forces.
   */
  private async pushWithRetry(rt: StoreRuntime, now: number): Promise<void> {
    const clone = rt.state.clone;
    rt.rejections = 0;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      let args = ["push", "--quiet", "origin", "HEAD"];
      if (await this.hasUpstream(clone)) {
        if ((await this.count(clone, "@{u}..HEAD")) === 0) {
          rt.state.pushRejected = false;
          return;
        }
      } else {
        if ((await this.tryGit(clone, "rev-parse", "--verify", "--quiet", "HEAD")) === undefined) {
          return; // nothing committed yet
        }
        args = ["push", "--quiet", "--set-upstream", "origin", "HEAD"];
      }
      await this.beforePush?.();
      try {
        await this.git(clone, ...args);
        rt.state.lastPush = timeText(new Date(now));
        rt.state.pushRejected = false;
        rt.rejections = 0;
        if (rt.state.paused && rt.state.pauseCause === PAUSE_PUSH_CONTENTION) this.resume(rt);
        return;
      } catch (e) {
        if (this.signal.aborted) return; // the runtime is shutting down
        if (classifyFailure((e as Error).message) !== "rejected") {
          this.remoteFailed(rt, "push", e as Error);
          return;
        }
      }
      rt.rejections++;
      rt.state.pushRejected = true;
      if (!(await this.fetch(rt, now)) || !(await this.integrate(rt))) return;
    }
    if (!rt.state.paused) rt.state.pausedSince = timeText(this.cfg.now());
    rt.state.paused = true;
    rt.state.pauseCause = PAUSE_PUSH_CONTENTION;
    rt.state.pauseMessage = `store ${goQuote(rt.state.store)} paused: push to ${rt.state.remote} was rejected ${MAX_PUSH_ATTEMPTS} times in a row because another machine kept pushing first; retrying at the next fetch interval`;
    goLogf(`[storesync] ${rt.state.pauseMessage}`);
  }

  private async conflictedPaths(clone: string): Promise<string[]> {
    const out = await this.tryGit(clone, "diff", "--name-only", "--diff-filter=U");
    if (out === undefined) return [];
    return uniqueSorted(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    );
  }

  /** saveConflictCopies keeps a copy of the local side of every conflict next to the runtime state. */
  private saveConflictCopies(store: string, local: Map<string, Buffer>): void {
    if (this.cfg.stateDir === "" || local.size === 0) return;
    const stamp = this.cfg
      .now()
      .toISOString()
      .replace(/\.\d+Z$/, "Z")
      .replace(/[-:]/g, "");
    const dir = join(this.cfg.stateDir, `${store}-conflicts`, stamp);
    for (const [p, data] of local) {
      const dst = join(dir, p);
      try {
        mkdirSync(dirname(dst), { recursive: true, mode: 0o755 });
        writeFileSync(dst, data, { mode: 0o644 });
      } catch {
        // ignored, as in Go
      }
    }
  }
}

/** changeSignature fingerprints the changed paths with their size and mtime. */
function changeSignature(clone: string, status: string): string {
  const h = createHash("sha256");
  h.update(status);
  for (const line of status.split("\n")) {
    const path = statusPath(line);
    if (path === "") continue;
    try {
      const info = statSync(join(clone, path), { bigint: true });
      h.update(`${path}|${info.size}|${info.mtimeNs}\n`);
    } catch {
      // a vanished path contributes nothing
    }
  }
  return h.digest("hex");
}
