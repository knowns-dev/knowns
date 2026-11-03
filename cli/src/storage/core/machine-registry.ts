// The read side of internal/registry/registry.go, which is all storage needs to resolve a project:
// load ~/.knowns/registry.json without writing, canonicalize path spellings, and look projects up.
// Mutating operations (add, remove, scan, save) belong to the full registry port.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type RegistryProject, registryFileSchema } from "../../models/registry.ts";
import { parseBoundary } from "../../schema/index.ts";
import { canonicalPath } from "./canonical-path.ts";
import { globalRootPath } from "./global-root.ts";
import { parseJsonPreservingNumbers } from "./util.ts";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** isInitializedKnowledgeRoot: a directory holding a config.json. */
export function isInitializedKnowledgeRoot(dir: string): boolean {
  return isDir(dir) && existsSync(join(dir, "config.json"));
}

function evalSymlinks(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Registry in the shape Manager needs; the full registry port implements the mutating methods. */
export interface ProjectRegistry {
  readonly projects: RegistryProject[];
  storesRoot(): string;
  knowledgeRoot(p: RegistryProject): string;
  isValid(p: RegistryProject): boolean;
  findStoreLinked(dir: string): RegistryProject | undefined;
  /** Optional: registers a project. Absent on the read-only registry. */
  add?(projectPath: string): RegistryProject | undefined;
  /** Optional: marks a project active. Absent on the read-only registry. */
  setActive?(id: string): void;
}

export class MachineRegistry implements ProjectRegistry {
  projects: RegistryProject[] = [];

  constructor(readonly filePath: string = join(globalRootPath(), "registry.json")) {}

  /** The directory holding store clones, next to the registry file. */
  storesRoot(): string {
    return join(this.filePath, "..", "stores");
  }

  /** Where a project's knowledge lives: its store folder, or its in-repo .knowns/. */
  knowledgeRoot(p: RegistryProject): string {
    if (p.store) return join(this.storesRoot(), p.store.name, p.store.project);
    return join(p.path, ".knowns");
  }

  isValid(p: RegistryProject): boolean {
    return isInitializedKnowledgeRoot(this.knowledgeRoot(p));
  }

  /**
   * LoadReadOnly: a missing file means no projects. Stored paths are rewritten to their on-disk
   * spelling in memory and de-duplicated (last occurrence wins); the file is never written.
   * A UTF-8 BOM is tolerated (Go 0.34.1 returns an empty list for a BOM-prefixed registry).
   */
  loadReadOnly(): void {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.projects = [];
        return;
      }
      throw new Error(`read registry: ${(e as Error).message}`);
    }
    const parsed = parseBoundary(
      registryFileSchema,
      parseJsonPreservingNumbers(text),
      "registry.json",
    );

    const seen = new Map<string, number>();
    const deduped: RegistryProject[] = [];
    for (const original of parsed) {
      const p = { ...original };
      const canonical = canonicalPath(p.path);
      if (canonical !== p.path) {
        // Only refresh a name derived from the path, so a name set elsewhere survives.
        if (p.name === basename(p.path)) p.name = basename(canonical);
        p.path = canonical;
      }
      const idx = seen.get(p.path);
      if (idx !== undefined) {
        deduped[idx] = p;
      } else {
        seen.set(p.path, deduped.length);
        deduped.push(p);
      }
    }
    this.projects = deduped;
  }

  /** FindByPath: compares on-disk spelling, so any casing that names the folder finds it. */
  findByPath(absPath: string): RegistryProject | undefined {
    const canonical = canonicalPath(absPath);
    return this.projects.find((p) => p.path === canonical);
  }

  /**
   * FindStoreLinked: the store-linked project registered for dir, also when dir and the registered
   * path name one folder through different symlinks.
   */
  findStoreLinked(dir: string): RegistryProject | undefined {
    const byPath = this.findByPath(dir);
    if (byPath) return byPath.store ? byPath : undefined;
    const resolved = evalSymlinks(dir);
    if (resolved === undefined) return undefined;
    return this.projects.find((p) => p.store && evalSymlinks(p.path) === resolved);
  }

  /** FindByKnowledgeRoot: the store-linked project whose knowledge lives at dir. */
  findByKnowledgeRoot(dir: string): RegistryProject | undefined {
    const canonical = canonicalPath(dir);
    const resolved = evalSymlinks(dir);
    for (const p of this.projects) {
      if (!p.store) continue;
      const root = this.knowledgeRoot(p);
      if (canonicalPath(root) === canonical) return p;
      if (resolved !== undefined && evalSymlinks(root) === resolved) return p;
    }
    return undefined;
  }
}

/**
 * loadMachineRegistry: ~/.knowns/registry.json read-only. A missing or unreadable registry means
 * no store mappings; resolution falls back to in-repo projects.
 */
export function loadMachineRegistry(): MachineRegistry | undefined {
  const reg = new MachineRegistry(join(globalRootPath(), "registry.json"));
  try {
    reg.loadReadOnly();
  } catch {
    return undefined;
  }
  return reg;
}
