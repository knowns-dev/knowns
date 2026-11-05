// The status and resolve halves of `knowns store` (internal/cli/store_status_cmd.go).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../../domain/storesync/git.ts";
import {
  isZeroTime,
  loadState,
  recordResolution,
  timeMs,
  ZERO_TIME,
} from "../../domain/storesync/state.ts";
import { globalRootPath } from "../../storage/core/global-root.ts";
import { MachineRegistry } from "../../storage/core/machine-registry.ts";
import { goJsonStringify } from "../../storage/core/util.ts";
import type { CommandContext } from "../core/define.ts";

/** One row of `knowns store status`. Field order is the Go struct order (JSON output). */
export interface StoreProjectStatus {
  store: string;
  project: string;
  codeRoot: string;
  folder: string;
  state: string;
  cause: string;
  pausedSince: string;
  conflictPaths: string[];
  lastPush: string;
  lastFetch: string;
  queuedCommits: number;
  lastError: string;
}

const STATE_HEALTHY = "healthy";
const STATE_NOT_SYNCED = "not synced yet";
const STATE_PAUSED_CONFLICT = "paused: conflict";
const STATE_PAUSED_STORE = "paused: store";

const goQuote = (s: string): string => JSON.stringify(s);

/** storeStateDir: where the runtime persists per-store sync state. */
export async function storeStateDir(): Promise<string> {
  const { runtimeRoot } = await import("../../runtime/queue.ts");
  return join(runtimeRoot(), "stores");
}

export async function collectStoreStatus(stateDir: string): Promise<StoreProjectStatus[]> {
  const reg = new MachineRegistry(join(globalRootPath(), "registry.json"));
  try {
    reg.loadReadOnly();
  } catch (e) {
    throw new Error(`read registry: ${(e as Error).message}`);
  }
  const rows: StoreProjectStatus[] = [];
  for (const p of reg.projects) {
    if (!p.store) continue;
    const row: StoreProjectStatus = {
      store: p.store.name,
      project: p.store.project,
      codeRoot: p.path,
      folder: reg.knowledgeRoot(p),
      state: "",
      cause: "",
      pausedSince: ZERO_TIME,
      conflictPaths: [],
      lastPush: ZERO_TIME,
      lastFetch: ZERO_TIME,
      queuedCommits: 0,
      lastError: "",
    };
    let state: ReturnType<typeof loadState> | undefined;
    try {
      state = loadState(stateDir, p.store.name);
    } catch {
      state = undefined;
    }
    if (!state) {
      row.state = STATE_NOT_SYNCED;
      row.cause = "the runtime has not synced this store yet; it starts with any Knowns command";
    } else if (state.paused) {
      row.state = STATE_PAUSED_STORE;
      row.cause = `${state.pauseCause}: ${state.pauseMessage}`;
      row.pausedSince = state.pausedSince;
    } else {
      row.state = STATE_HEALTHY;
    }
    if (state) {
      row.lastPush = state.lastPush;
      row.lastFetch = state.lastFetch;
      row.queuedCommits = state.queuedCommits;
      row.lastError = state.lastError;
      for (const c of state.conflicts) {
        if (c.project === p.store.project && row.state !== STATE_PAUSED_STORE) {
          row.state = STATE_PAUSED_CONFLICT;
          row.cause = `conflicting changes in ${c.paths.join(", ")}; run 'knowns store resolve'`;
          row.pausedSince = c.since;
          row.conflictPaths = c.paths;
        }
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) =>
    a.store !== b.store
      ? a.store < b.store
        ? -1
        : 1
      : a.project < b.project
        ? -1
        : a.project > b.project
          ? 1
          : 0,
  );
  return rows;
}

/** rowsJson: json.MarshalIndent of the rows (omitempty on cause, conflictPaths, lastError). */
export function rowsJson(rows: StoreProjectStatus[]): string {
  const out = rows.map((r) => {
    const o: Record<string, unknown> = {
      store: r.store,
      project: r.project,
      codeRoot: r.codeRoot,
      folder: r.folder,
      state: r.state,
    };
    if (r.cause !== "") o.cause = r.cause;
    o.pausedSince = r.pausedSince;
    if (r.conflictPaths.length > 0) o.conflictPaths = r.conflictPaths;
    o.lastPush = r.lastPush;
    o.lastFetch = r.lastFetch;
    o.queuedCommits = r.queuedCommits;
    if (r.lastError !== "") o.lastError = r.lastError;
    return o;
  });
  return goJsonStringify(out);
}

/** ago: Go's `now.Sub(t).Round(time.Second)` rendering used by the status table. */
export function ago(t: string, nowMs: number): string {
  if (isZeroTime(t)) return "never";
  const diff = (nowMs - timeMs(t)) / 1000;
  // Duration.Round rounds halves away from zero.
  const secs = diff < 0 ? -Math.round(-diff) : Math.round(diff);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.trunc(secs / 60)}m ago`;
  if (secs < 48 * 3600) return `${Math.trunc(secs / 3600)}h ago`;
  return `${Math.trunc(secs / 86400)}d ago`;
}

const runeLen = (s: string): number => [...s].length;

/** printStoreStatus: the tabwriter table (minwidth 0, tabwidth 2, padding 2) plus the detail blocks. */
export function statusText(rows: StoreProjectStatus[], nowMs: number): string {
  if (rows.length === 0) {
    return "No repository on this machine is linked to a store. Link one with 'knowns store link <remote>'.\n";
  }
  const table: string[][] = [["STORE", "PROJECT", "STATE", "LAST PUSH", "LAST FETCH", "QUEUED"]];
  for (const r of rows) {
    table.push([
      r.store,
      r.project,
      r.state,
      ago(r.lastPush, nowMs),
      ago(r.lastFetch, nowMs),
      String(r.queuedCommits),
    ]);
  }
  const widths = [0, 1, 2, 3, 4].map(
    (c) => Math.max(...table.map((row) => runeLen(row[c] as string))) + 2,
  );
  let out = "";
  for (const row of table) {
    for (let c = 0; c < 5; c++) {
      const cell = row[c] as string;
      out += cell + " ".repeat((widths[c] as number) - runeLen(cell));
    }
    out += `${row[5]}\n`;
  }
  for (const r of rows) {
    if (r.state === STATE_HEALTHY && r.lastError === "") continue;
    out += `\n${r.store}/${r.project} (${r.codeRoot}):\n`;
    if (r.cause !== "") {
      let line = `  ${r.cause}`;
      if (!isZeroTime(r.pausedSince)) line += ` (paused ${ago(r.pausedSince, nowMs)})`;
      out += `${line}\n`;
    }
    if (r.lastError !== "") out += `  last error: ${r.lastError}\n`;
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** selectConflictPaths maps requested paths onto the recorded conflicting paths; none means all. */
function selectConflictPaths(target: StoreProjectStatus, requested: string[]): string[] {
  if (requested.length === 0) return target.conflictPaths;
  const known = new Set(target.conflictPaths);
  const out: string[] = [];
  for (const raw of requested) {
    const r = raw.trim().replaceAll("\\", "/");
    let candidate = r;
    if (!known.has(candidate)) candidate = `${target.project}/${r}`;
    if (!known.has(candidate)) {
      throw new Error(
        `${r} is not a conflicting path of ${target.project}; conflicting paths: ${target.conflictPaths.join(", ")}`,
      );
    }
    out.push(candidate);
  }
  return out;
}

/** A time stamped like Go's 20060102T150405Z. */
const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");

export async function runResolve(ctx: CommandContext): Promise<void> {
  const stateDir = await storeStateDir();
  const rows = await collectStoreStatus(stateDir);
  if (ctx.args.length === 0) {
    let found = false;
    for (const r of rows) {
      if (r.state !== STATE_PAUSED_CONFLICT) continue;
      found = true;
      ctx.print(`${r.store}/${r.project} paused ${ago(r.pausedSince, Date.now())}:\n`);
      for (const p of r.conflictPaths) ctx.print(`  ${p}\n`);
    }
    if (!found) {
      ctx.print("No project is paused by a conflict.\n");
      return;
    }
    ctx.print(
      "\nShow versions with 'knowns store resolve <project>', then settle with --keep local|remote|both.\n",
    );
    return;
  }

  const project = ctx.args[0] as string;
  const storeFlag = ctx.flags.string("store");
  let target: StoreProjectStatus | undefined;
  for (const row of rows) {
    if (
      row.project === project &&
      (storeFlag === "" || row.store === storeFlag) &&
      row.state === STATE_PAUSED_CONFLICT
    ) {
      if (target) {
        throw new Error(
          `project ${goQuote(project)} is paused in more than one store; choose one with --store`,
        );
      }
      target = row;
    }
  }
  if (!target) throw new Error(`project ${goQuote(project)} is not paused by a conflict`);

  const rest = ctx.args.slice(1);
  const paths = selectConflictPaths(target, rest);
  const clone = dirname(target.folder);
  const keep = ctx.flags.string("keep");
  if (keep === "") {
    for (const p of paths) {
      let diff = "";
      try {
        diff = await git(undefined, clone, 0, undefined, "diff", "--no-color", "HEAD", "--", p);
      } catch {
        diff = "";
      }
      if (diff.trim() === "") diff = "(local and remote versions are identical)\n";
      ctx.print(
        `== ${p}\n-- remote: the version in the store's history\n++ local: the version on this machine\n${diff}\n`,
      );
    }
    ctx.print(
      `Settle with: knowns store resolve ${project} ${rest.join(" ")} --keep local|remote|both\n`,
    );
    return;
  }
  if (keep !== "local" && keep !== "remote" && keep !== "both") {
    throw new Error(`--keep must be local, remote or both, not ${goQuote(keep)}`);
  }

  const { withSyncLocks } = await import("../../storage/core/locks.ts");
  const { gitBytes } = await import("../../domain/storesync/git.ts");
  const prefix = `${target.project}/`;
  const rel = paths.map((p) => {
    const s = p.replaceAll("\\", "/");
    return s.startsWith(prefix) ? s.slice(prefix.length) : s;
  });
  const saved: string[] = [];
  const tgt = target;
  await withSyncLocks(tgt.folder, rel, async () => {
    for (const p of paths) {
      if (keep === "remote") {
        try {
          await git(undefined, clone, 0, undefined, "checkout", "HEAD", "--", p);
        } catch (e) {
          throw new Error(`restore remote version of ${p}: ${(e as Error).message}`);
        }
      } else if (keep === "both") {
        let remote: Buffer;
        try {
          remote = await gitBytes(undefined, clone, 0, undefined, "show", `HEAD:${p}`);
        } catch {
          continue; // deleted in the store; the local version stays
        }
        const dst = join(stateDir, `${tgt.store}-kept`, stamp(), ...p.split("/"));
        mkdirSync(dirname(dst), { recursive: true, mode: 0o755 });
        writeFileSync(dst, remote, { mode: 0o644 });
        saved.push(dst);
      }
    }
  });
  try {
    recordResolution(stateDir, target.store, { project: target.project, paths });
  } catch (e) {
    throw new Error(`record resolution: ${(e as Error).message}`);
  }
  // The runtime applies the resolution; make sure it is running.
  try {
    (await import("../../runtime/queue.ts")).ensureDaemon();
  } catch (e) {
    ctx.printErr(
      `Warning: could not start the runtime that syncs the store: ${(e as Error).message}\n`,
    );
  }
  ctx.print(
    `Kept the ${keep} version of ${paths.length} entit${plural(paths.length, "y", "ies")} in ${target.store}/${target.project}.\n`,
  );
  for (const s of saved) ctx.print(`Saved the remote version to ${s}\n`);
  const remaining = target.conflictPaths.length - paths.length;
  if (remaining > 0) {
    ctx.print(
      `${remaining} conflicting entit${plural(remaining, "y", "ies")} left; sync for ${target.project} resumes once all are settled.\n`,
    );
  } else {
    ctx.print(`Sync for ${target.project} resumes on the runtime's next pass.\n`);
  }
}
