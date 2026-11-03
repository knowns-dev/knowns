// Port of internal/storage/project_location.go.
import { statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { StoreMapping } from "../../models/registry.ts";
import { globalRootPath } from "./global-root.ts";
import {
  isInitializedKnowledgeRoot,
  loadMachineRegistry,
  type MachineRegistry,
} from "./machine-registry.ts";

/**
 * Where a project's knowledge and code live. The two roots are independent: a store-linked
 * project keeps its knowledge in a store clone.
 */
export interface ProjectLocation {
  knowledgeRoot: string;
  projectRoot: string;
  /** The store mapping the location came from; absent for an in-repo project. */
  store?: StoreMapping;
  /** An in-repo .knowns/ that exists but is shadowed because the project is linked to a store. */
  ignoredKnowns?: string;
  /** A store mapping recorded for the repository whose folder is missing or not initialized. */
  brokenStore?: StoreMapping;
  brokenStoreFolder?: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function brokenStoreMessage(m: StoreMapping, folder: string): string {
  return `this repository is linked to store "${m.name}" (folder "${m.project}"), but ${folder} is missing or not initialized; run 'knowns store link' again or check the store clone`;
}

/** IgnoredKnownsWarning: the message for an in-repo .knowns/ shadowed by a store, or "". */
export function ignoredKnownsWarning(loc: ProjectLocation): string {
  if (!loc.ignoredKnowns || !loc.store) return "";
  return `${loc.ignoredKnowns} is ignored: this project's knowledge lives in store "${loc.store.name}" (folder "${loc.store.project}"). Remove it once everyone on the project has migrated.`;
}

/** Warnings: messages callers print for a location. */
export function locationWarnings(loc: ProjectLocation): string[] {
  const out: string[] = [];
  const ignored = ignoredKnownsWarning(loc);
  if (ignored) out.push(ignored);
  if (loc.brokenStore) {
    out.push(
      `${brokenStoreMessage(loc.brokenStore, loc.brokenStoreFolder ?? "")}; using ${loc.knowledgeRoot} meanwhile.`,
    );
  }
  return out;
}

/** locateAt resolves dir itself. Returns undefined when there is no project at dir; throws for an unusable store mapping with no in-repo fallback. */
function locateAt(reg: MachineRegistry | undefined, dir: string): ProjectLocation | undefined {
  const inRepo = join(dir, ".knowns");
  const inRepoValid = isInitializedKnowledgeRoot(inRepo);

  let broken: NonNullable<ReturnType<MachineRegistry["findStoreLinked"]>> | undefined;
  if (reg) {
    const p = reg.findStoreLinked(dir);
    if (p) {
      if (reg.isValid(p)) {
        const loc: ProjectLocation = {
          knowledgeRoot: reg.knowledgeRoot(p),
          projectRoot: dir,
          ...(p.store ? { store: p.store } : {}),
        };
        if (isDir(inRepo)) loc.ignoredKnowns = inRepo;
        return loc;
      }
      broken = p;
    }
  }
  if (inRepoValid) {
    const loc: ProjectLocation = { knowledgeRoot: inRepo, projectRoot: dir };
    if (broken?.store && reg) {
      loc.brokenStore = broken.store;
      loc.brokenStoreFolder = reg.knowledgeRoot(broken);
    }
    return loc;
  }
  if (broken?.store && reg) {
    throw new Error(brokenStoreMessage(broken.store, reg.knowledgeRoot(broken)));
  }
  return undefined;
}

/**
 * LocateProject: walk up from startDir to the nearest directory that is a project, either through
 * a store mapping in the machine registry or an initialized in-repo .knowns/. At the same
 * directory a store mapping wins over an in-repo .knowns/.
 */
export function locateProject(startDir: string): ProjectLocation {
  const reg = loadMachineRegistry();
  let dir = startDir;
  for (;;) {
    const loc = locateAt(reg, dir);
    if (loc) return loc;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no .knowns/ directory found (started from ${startDir})`);
}

/**
 * LocateProjectAt: resolve exactly projectRoot without walking up, for callers handed a project
 * directory (--project, set_project).
 */
export function locateProjectAt(projectRoot: string): ProjectLocation {
  const abs = resolve(projectRoot);
  const loc = locateAt(loadMachineRegistry(), abs);
  if (loc) return loc;
  throw new Error(`no initialized .knowns/ directory and no linked store at ${abs}`);
}

/** FindProjectRoot: the knowledge root of the nearest project. */
export function findProjectRoot(startDir: string): string {
  return locateProject(startDir).knowledgeRoot;
}

/** inRepoProjectRoot: the code root of an in-repo project is the parent of its .knowns/. */
export function inRepoProjectRoot(knowledgeRoot: string): string {
  return dirname(knowledgeRoot);
}

/** inStoresDir: a cheap textual gate; every store folder sits under <global root>/stores. */
export function inStoresDir(path: string): boolean {
  const marker = `${sep}.knowns${sep}stores${sep}`;
  return `${resolve(path)}${sep}`.includes(marker);
}

interface StoreRootsCache {
  file: string;
  mtimeMs: number;
  size: number;
  roots: Map<string, string>;
}
let storeRootsCache: StoreRootsCache | undefined;

/** Looks up the code root of a store folder, cached until registry.json changes on disk. */
function storeProjectRoot(knowledgeRoot: string): string | undefined {
  const file = join(globalRootPath(), "registry.json");
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  if (
    !storeRootsCache ||
    storeRootsCache.file !== file ||
    storeRootsCache.mtimeMs !== stat.mtimeMs ||
    storeRootsCache.size !== stat.size
  ) {
    storeRootsCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, roots: new Map() };
  }
  const hit = storeRootsCache.roots.get(knowledgeRoot);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  const reg = loadMachineRegistry();
  const root = reg?.findByKnowledgeRoot(knowledgeRoot)?.path ?? "";
  storeRootsCache.roots.set(knowledgeRoot, root);
  return root === "" ? undefined : root;
}

/**
 * projectRootForKnowledgeRoot: the code root for a Store built from a knowledge root alone. An
 * in-repo .knowns/ sits inside its repository; a folder in a store clone belongs to whichever
 * repository the registry maps to it; other roots keep the parent directory.
 */
export function projectRootForKnowledgeRoot(knowledgeRoot: string): string {
  if (basename(knowledgeRoot) !== ".knowns" && inStoresDir(knowledgeRoot)) {
    const root = storeProjectRoot(knowledgeRoot);
    if (root) return root;
  }
  return inRepoProjectRoot(knowledgeRoot);
}
