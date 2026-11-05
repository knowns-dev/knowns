// The helpers behind `knowns store link` (internal/cli/store_cmd.go and store_migrate.go): store
// naming, cloning, and copying an in-repo .knowns/ into a store project folder.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, git } from "./git.ts";

/** storeNameFromRemote: git@host:team/knowledge.git and https://host/team/knowledge give "knowledge". */
export function storeNameFromRemote(remote: string): string {
  let name = remote.replace(/\/+$/, "");
  const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf(":"));
  if (i >= 0) name = name.slice(i + 1);
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

export function isStoreSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\:]/.test(name);
}

export function isInitializedFolder(dir: string): boolean {
  return existsSync(join(dir, "config.json"));
}

/** folderHasContent: dir exists with any entry in it. */
export function folderHasContent(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const runStoreGit = (
  signal: AbortSignal | undefined,
  dir: string,
  ...args: string[]
): Promise<string> => git(signal, dir, DEFAULT_GIT_TIMEOUT_MS, undefined, ...args);

/**
 * ensureStoreClone makes sure dir is a clone of remote. It clones when dir is absent and reports
 * whether it did; an existing clone of another remote is an error rather than something to overwrite.
 */
export async function ensureStoreClone(
  signal: AbortSignal | undefined,
  dir: string,
  remote: string,
): Promise<boolean> {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    let origin: string;
    try {
      origin = await runStoreGit(signal, dir, "remote", "get-url", "origin");
    } catch (e) {
      throw new Error(`${dir} exists but is not a Git clone of a store: ${(e as Error).message}`);
    }
    if (origin.trim() !== remote) {
      throw new Error(
        `${dir} is already a clone of ${origin.trim()}, not ${remote}; use --store to pick another store name`,
      );
    }
    return false;
  }
  try {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error(`create stores directory: ${(e as Error).message}`);
  }
  try {
    await runStoreGit(signal, "", "clone", "--", remote, dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not clone store ${remote}: ${(e as Error).message}`);
  }
  return true;
}

/**
 * The top-level entries of a knowledge root that store spec D1 keeps out of a store. A migration
 * copies them so this machine keeps its history, timers and index, but the store .gitignore keeps
 * them out of sync.
 */
const STORE_LOCAL_ONLY_PATHS = [
  ".search",
  "history",
  "time.json",
  "time-entries.json",
  "workspaces.json",
  "chats.json",
  ".server-port",
];

/** What `store link --migrate` copied. */
export interface MigrationReport {
  tasks: number;
  docs: number;
  decisions: number;
  memories: number;
  localOnly: string[];
}

/** copyKnowledge copies an in-repo .knowns/ into a store project folder verbatim; src is only read. */
export function copyKnowledge(src: string, dst: string): MigrationReport {
  const report: MigrationReport = { tasks: 0, docs: 0, decisions: 0, memories: 0, localOnly: [] };
  for (const p of STORE_LOCAL_ONLY_PATHS) {
    try {
      lstatSync(join(src, p));
      report.localOnly.push(p);
    } catch {
      // absent
    }
  }
  const walk = (dir: string): void => {
    const rel = relative(src, dir);
    mkdirSync(join(dst, rel), { recursive: true, mode: 0o755 });
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks and devices are not knowledge
      const relFile = relative(src, path);
      const target = join(dst, relFile);
      const info = statSync(path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(path, target);
      utimesSync(target, info.atime, info.mtime);
      if (relFile.endsWith(".md")) {
        switch (relFile.split(sep)[0]) {
          case "tasks":
          case "archive":
            report.tasks++;
            break;
          case "docs":
            report.docs++;
            break;
          case "decisions":
            report.decisions++;
            break;
          case "memory":
            report.memories++;
            break;
        }
      }
    }
  };
  walk(src);
  return report;
}

export function migrationReportText(r: MigrationReport, inRepo: string): string {
  let out = `Migrated ${r.tasks} task${plural(r.tasks, "", "s")}, ${r.docs} doc${plural(r.docs, "", "s")}, ${r.decisions} decision${plural(r.decisions, "", "s")} and ${r.memories} memor${plural(r.memories, "y", "ies")} with their IDs unchanged.\n`;
  if (r.localOnly.length > 0) {
    out += `Kept on this machine only, never synced (store spec D1): ${r.localOnly.join(", ")}\n`;
  }
  out += `${inRepo} was left in place and is ignored from now on; remove it once everyone on the project has migrated.\n`;
  return out;
}
