// Port of internal/registry/registry.go: the machine-level project registry at
// ~/.knowns/registry.json. Extends the read side in storage/core with every mutating operation.
// The file is written exactly as Go does: json.MarshalIndent of the project array, two-space
// indent, NO trailing newline, mode 0644 (not atomic).
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RegistryProject, StoreMapping } from "../../models/registry.ts";
import { registryFileSchema } from "../../models/registry.ts";
import { parseBoundary } from "../../schema/index.ts";
import { canonicalPath } from "../core/canonical-path.ts";
import { globalRootPath } from "../core/global-root.ts";
import { MachineRegistry } from "../core/machine-registry.ts";
import { goJsonStringify, parseJsonPreservingNumbers, sortKeysDeep } from "../core/util.ts";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_MAX = 2176782336; // 36^6

/** util.GenerateID: a 6-character base36 ID. */
export function generateRegistryId(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0] as number;
  } while (n >= Math.floor(2 ** 32 / ID_MAX) * ID_MAX);
  n %= ID_MAX;
  let id = "";
  for (let i = 0; i < 6; i++) {
    id = BASE36[n % 36] + id;
    n = Math.floor(n / 36);
  }
  return id;
}

/** time.Now() marshalled by encoding/json: RFC 3339 in the local zone, trailing zeros trimmed. */
export function goTimeNow(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -date.getTimezoneOffset();
  const zone =
    off === 0
      ? "Z"
      : `${off > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const ms = pad(date.getMilliseconds(), 3).replace(/0+$/, "");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${ms === "" ? "" : `.${ms}`}${zone}`
  );
}

/** isPathSegment: one plain directory name, so a mapping can never leave the stores directory. */
export function isPathSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalAbs(projectPath: string): string {
  return canonicalPath(resolve(projectPath));
}

/** The Go struct field order: id, name, path, lastUsed, store, machine (omitted when empty). */
function projectForJson(p: RegistryProject): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    path: p.path,
    lastUsed: p.lastUsed,
  };
  if (p.store) {
    const store: Record<string, unknown> = { name: p.store.name, project: p.store.project };
    if (p.store.remote) store.remote = p.store.remote;
    out.store = store;
  }
  if (p.machine && Object.keys(p.machine).length > 0) out.machine = sortKeysDeep(p.machine);
  return out;
}

/** Registry: MachineRegistry plus add, remove, scan, save and the store-link operations. */
export class Registry extends MachineRegistry {
  constructor(filePath: string = join(globalRootPath(), "registry.json")) {
    super(filePath);
  }

  /** Load: a missing file is empty; entries under a stale path spelling are repaired and saved. */
  load(): void {
    this.loadFile(true);
  }

  override loadReadOnly(): void {
    this.loadFile(false);
  }

  private loadFile(repair: boolean): void {
    const before = this.rawLoad();
    if (before === undefined) {
      this.projects = [];
      return;
    }
    const seen = new Map<string, number>();
    const deduped: RegistryProject[] = [];
    let changed = false;
    for (const original of before) {
      const p = { ...original };
      const canonical = canonicalPath(p.path);
      if (canonical !== p.path) {
        if (p.name === basename(p.path)) p.name = basename(canonical);
        p.path = canonical;
        changed = true;
      }
      const idx = seen.get(p.path);
      if (idx !== undefined) {
        deduped[idx] = p;
        changed = true;
      } else {
        seen.set(p.path, deduped.length);
        deduped.push(p);
      }
    }
    this.projects = deduped;
    if (changed && repair) {
      try {
        this.save();
      } catch {
        // an unwritable registry must not fail the read
      }
    }
  }

  private rawLoad(): RegistryProject[] | undefined {
    if (!existsSync(this.filePath)) return undefined;
    // Delegate reading (and BOM stripping) to the base reader without its path repair, by
    // parsing here: the base loadReadOnly also canonicalizes, which loadFile redoes to track
    // whether anything changed.
    const text = readFileSync(this.filePath, "utf8");
    return parseBoundary(registryFileSchema, parseJsonPreservingNumbers(text), "registry.json");
  }

  /** Save: json.MarshalIndent(projects) with no trailing newline, creating parent directories. */
  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o755 });
    writeFileSync(this.filePath, goJsonStringify(this.projects.map(projectForJson)), {
      mode: 0o644,
    });
  }

  /** Add: register an in-repo project. An already registered path returns its existing entry. */
  add(projectPath: string): RegistryProject {
    const abs = canonicalAbs(projectPath);
    const early = this.findByPath(abs);
    if (early?.store) return early;

    const knDir = join(abs, ".knowns");
    if (!isDir(knDir)) {
      throw new Error(
        `no .knowns/ directory found at ${abs} and no store is linked; run 'knowns init' to keep knowledge in the repository, or 'knowns store link <remote>' to keep it in a store`,
      );
    }
    if (!existsSync(join(knDir, "config.json"))) {
      throw new Error(`no config.json found at ${abs} - run 'knowns init' first`);
    }
    const existing = this.findByPath(abs);
    if (existing) return existing;

    const p: RegistryProject = {
      id: generateRegistryId(),
      name: basename(abs),
      path: abs,
      lastUsed: goTimeNow(),
    };
    this.projects.push(p);
    this.save();
    return p;
  }

  /** AddStoreLinked: register (or map an existing entry) a project whose knowledge is in a store. */
  addStoreLinked(projectPath: string, mapping: StoreMapping): RegistryProject {
    const abs = canonicalAbs(projectPath);
    if (!isDir(abs)) throw new Error(`project directory not found at ${abs}`);
    if (!isPathSegment(mapping.name) || !isPathSegment(mapping.project)) {
      throw new Error(
        `store mapping needs a store name and a project folder, each a single path segment (got "${mapping.name}" and "${mapping.project}")`,
      );
    }
    const candidate: RegistryProject = {
      id: "",
      name: "",
      path: abs,
      lastUsed: "",
      store: mapping,
    };
    if (!this.isValid(candidate)) {
      throw new Error(
        `store "${mapping.name}" has no initialized project folder "${mapping.project}" at ${this.knowledgeRoot(candidate)}`,
      );
    }
    const existing = this.findByPath(abs);
    if (existing) {
      existing.store = mapping;
      this.save();
      return existing;
    }
    const p: RegistryProject = {
      id: generateRegistryId(),
      name: basename(abs),
      path: abs,
      lastUsed: goTimeNow(),
      store: mapping,
    };
    this.projects.push(p);
    this.save();
    return p;
  }

  /** SetMachine: replace the machine-state settings of the store-linked project; empty removes. */
  setMachine(projectPath: string, machine: Record<string, unknown>): void {
    const p = this.findStoreLinked(projectPath);
    if (!p) throw new Error(`no store is linked at ${projectPath}`);
    if (Object.keys(machine).length === 0) delete p.machine;
    else p.machine = machine;
    this.save();
  }

  /** ClearStore: the entry stays registered and becomes an in-repo project. */
  clearStore(projectPath: string): void {
    const abs = canonicalAbs(projectPath);
    const existing = this.findByPath(abs);
    if (!existing?.store) throw new Error(`no store is linked at ${abs}`);
    delete existing.store;
    this.save();
  }

  /** Remove a project by ID. */
  remove(id: string): void {
    const i = this.projects.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`project ${id} not found`);
    this.projects.splice(i, 1);
    this.save();
  }

  /** SetActive: refresh LastUsed. */
  setActive(id: string): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Error(`project ${id} not found`);
    p.lastUsed = goTimeNow();
    this.save();
  }

  /** GetActive: the most recently used project. */
  getActive(): RegistryProject | undefined {
    let best: RegistryProject | undefined;
    for (const p of this.projects) {
      if (!best || Date.parse(p.lastUsed) > Date.parse(best.lastUsed)) best = p;
    }
    return best;
  }

  /** List: every registered project. */
  list(): RegistryProject[] {
    return [...this.projects];
  }

  /** Scan: depth-1 search of dirs for initialized .knowns/ folders; returns the newly added. */
  scan(dirs: readonly string[]): RegistryProject[] {
    const added: RegistryProject[] = [];
    for (const dir of dirs) {
      const absDir = resolve(dir);
      let entries: Dirent[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(absDir, entry.name);
        const knDir = join(candidate, ".knowns");
        if (!isDir(knDir) || !existsSync(join(knDir, "config.json"))) continue;
        if (this.findByPath(candidate)) continue;
        try {
          added.push({ ...this.add(candidate) });
        } catch {
          // skipped, as in Go
        }
      }
    }
    return added;
  }
}

/** NewRegistry (default path) loaded with repair. */
export function loadRegistry(filePath?: string): Registry {
  const reg = new Registry(filePath);
  reg.load();
  return reg;
}
