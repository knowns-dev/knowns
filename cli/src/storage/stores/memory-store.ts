// Port of internal/storage/memory_store.go: memories in .knowns/memory/ (project layer) and
// ~/.knowns/memory/ (global layer). Mutations take the per-memory lock under the global root.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GO_ZERO_TIME } from "../../models/common.ts";
import { newTaskId } from "../../models/id.ts";
import {
  demoteLayer,
  isLegacyDecisionMemoryCategory,
  LEGACY_DECISION_MEMORY_WRITE_ERROR,
  LEGACY_DECISION_MIGRATION_ID_KEY,
  MEMORY_LAYER_GLOBAL,
  MEMORY_LAYER_PROJECT,
  type MemoryEntry,
  memoryApplyLifecycleDefaults,
  memoryFileName,
  promoteLayer,
  validateLegacyDecisionMemoryUpdate,
  validateMemoryId,
  validateNewMemoryCategory,
  validMemoryLayer,
} from "../../models/memory.ts";
import { globalRootPath } from "../core/global-root.ts";
import type { Store } from "../core/store.ts";
import { atomicWrite, goTrimSpace, splitFrontmatter } from "../core/util.ts";
import {
  asInt,
  asStr,
  asStrList,
  formatIso,
  isZeroTime,
  parseYamlMap,
  readDirSorted,
  readTime,
  yamlScalar,
} from "./internal.ts";

const LIFECYCLE_FIELDS = ["status", "confidence", "lastVerified", "ttlDays", "sources"];

function missingLifecycleFields(raw: Record<string, unknown> | undefined): string[] {
  if (!raw) return [...LIFECYCLE_FIELDS];
  return LIFECYCLE_FIELDS.filter((f) => !Object.hasOwn(raw, f));
}

/** parseMemoryContent: a memory file's markdown into a MemoryEntry. */
export function parseMemoryContent(content: string, layer: string): MemoryEntry {
  const { yaml, body } = splitFrontmatter(content);
  const entry: MemoryEntry = {
    id: "",
    title: "",
    layer,
    content: goTrimSpace(body),
    createdAt: GO_ZERO_TIME,
    updatedAt: GO_ZERO_TIME,
    lastVerified: GO_ZERO_TIME,
  };
  if (yaml === "") {
    entry.lifecycleMetadataMissing = missingLifecycleFields(undefined);
    memoryApplyLifecycleDefaults(entry);
    return entry;
  }
  let fm: Record<string, unknown>;
  try {
    fm = parseYamlMap(yaml);
  } catch (e) {
    throw new Error(`parse memory frontmatter: ${(e as Error).message}`);
  }
  entry.id = asStr(fm.id);
  entry.title = asStr(fm.title);
  const set = <
    K extends "key" | "category" | "status" | "confidence" | "mergedInto" | "rejectedReason",
  >(
    k: K,
  ) => {
    const v = asStr(fm[k]);
    if (v !== "") entry[k] = v;
  };
  set("key");
  set("category");
  set("status");
  set("confidence");
  entry.lastVerified = readTime(asStr(fm.lastVerified));
  const ttl = asInt(fm.ttlDays);
  if (ttl !== 0) entry.ttlDays = ttl;
  entry.sources = asStrList(fm.sources);
  set("mergedInto");
  set("rejectedReason");
  entry.tags = asStrList(fm.tags);
  if (fm.metadata !== undefined && fm.metadata !== null) {
    if (typeof fm.metadata !== "object" || Array.isArray(fm.metadata)) {
      throw new Error("parse memory frontmatter: metadata must be a mapping");
    }
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) meta[k] = asStr(v);
    if (Object.keys(meta).length > 0) entry.metadata = meta;
  }
  entry.createdAt = readTime(asStr(fm.createdAt));
  entry.updatedAt = readTime(asStr(fm.updatedAt));
  const fmLayer = asStr(fm.layer);
  if (fmLayer !== "") entry.layer = fmLayer;
  entry.lifecycleMetadataMissing = missingLifecycleFields(fm);
  memoryApplyLifecycleDefaults(entry);
  return entry;
}

/**
 * renderMemory: the canonical markdown for a memory file. Go ranges over the metadata map in
 * random order; sorted keys are one of its possible outputs and make this deterministic.
 */
export function renderMemory(entry: MemoryEntry): string {
  let b = "---\n";
  b += `id: ${entry.id}\n`;
  b += `title: ${yamlScalar(entry.title)}\n`;
  if (entry.key) b += `key: ${yamlScalar(entry.key)}\n`;
  b += `layer: ${entry.layer}\n`;
  if (entry.category) b += `category: ${yamlScalar(entry.category)}\n`;
  if (entry.status) b += `status: ${yamlScalar(entry.status)}\n`;
  if (entry.confidence) b += `confidence: ${yamlScalar(entry.confidence)}\n`;
  if (!isZeroTime(entry.lastVerified)) b += `lastVerified: '${formatIso(entry.lastVerified)}'\n`;
  if ((entry.ttlDays ?? 0) > 0) b += `ttlDays: ${entry.ttlDays}\n`;
  if (entry.sources && entry.sources.length > 0) {
    b += `sources:\n${entry.sources.map((s) => `  - ${yamlScalar(s)}\n`).join("")}`;
  }
  if (entry.mergedInto) b += `mergedInto: ${yamlScalar(entry.mergedInto)}\n`;
  if (entry.rejectedReason) b += `rejectedReason: ${yamlScalar(entry.rejectedReason)}\n`;
  const tags = entry.tags ?? [];
  if (tags.length === 0) b += "tags: []\n";
  else b += `tags:\n${tags.map((t) => `  - ${t}\n`).join("")}`;
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    b += "metadata:\n";
    for (const k of Object.keys(entry.metadata).sort()) {
      b += `  ${k}: ${yamlScalar(entry.metadata[k] as string)}\n`;
    }
  }
  b += `createdAt: '${formatIso(entry.createdAt)}'\n`;
  b += `updatedAt: '${formatIso(entry.updatedAt)}'\n`;
  b += "---\n";
  const content = entry.content ?? "";
  if (content !== "") {
    b += `\n${content}`;
    if (!content.endsWith("\n")) b += "\n";
  }
  return b;
}

function slugifyReferenceTitle(title: string): string {
  let out = "";
  let prevHyphen = false;
  for (const ch of title.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      prevHyphen = false;
    } else if (ch === "-" || ch === " " || ch === "_") {
      if (!prevHyphen) {
        out += "-";
        prevHyphen = true;
      }
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

function stripEmpty<T>(v: T[] | undefined): T[] | undefined {
  return v && v.length > 0 ? v : undefined;
}

/** memoryEntriesMigrationEqual: structural equality ignoring updatedAt and derived warnings. */
function migrationEqual(a: MemoryEntry, b: MemoryEntry): boolean {
  const norm = (m: MemoryEntry) => ({
    ...m,
    sources: stripEmpty(m.sources),
    tags: stripEmpty(m.tags),
    metadata: m.metadata && Object.keys(m.metadata).length > 0 ? m.metadata : undefined,
    lifecycleMetadataMissing: undefined,
    updatedAt: undefined,
  });
  return Bun.deepEquals(JSON.parse(JSON.stringify(norm(a))), JSON.parse(JSON.stringify(norm(b))));
}

export class MemoryStore {
  readonly root: string;

  constructor(
    private readonly store: Pick<Store, "root" | "withMemoryLock">,
    readonly globalRoot: string = globalRootPath(),
  ) {
    this.root = store.root;
  }

  projectDir(): string {
    return join(this.root, "memory");
  }
  globalDir(): string {
    return join(this.globalRoot, "memory");
  }

  private dirForLayer(layer: string): string {
    if (layer === MEMORY_LAYER_PROJECT) return this.projectDir();
    if (layer === MEMORY_LAYER_GLOBAL) return this.globalDir();
    throw new Error(`invalid memory layer: "${layer}"`);
  }

  listLocal(): MemoryEntry[] {
    return this.listLayers([MEMORY_LAYER_PROJECT]);
  }

  listGlobalOnly(): MemoryEntry[] {
    return this.listLayers([MEMORY_LAYER_GLOBAL]);
  }

  /** List: all layers, or one when `layer` is set. */
  list(layer = ""): MemoryEntry[] {
    if (layer !== "" && !validMemoryLayer(layer))
      throw new Error(`invalid memory layer: "${layer}"`);
    return this.listLayers(layer === "" ? [MEMORY_LAYER_PROJECT, MEMORY_LAYER_GLOBAL] : [layer]);
  }

  listPersistent(layer = ""): MemoryEntry[] {
    return this.list(layer);
  }

  private listLayers(layers: string[]): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    for (const layer of layers) {
      for (const e of readDirSorted(this.dirForLayer(layer))) {
        if (e.isDirectory() || !e.name.endsWith(".md") || !e.name.startsWith("memory-")) continue;
        try {
          entries.push(this.parseFile(join(this.dirForLayer(layer), e.name), layer));
        } catch {
          // skip unreadable
        }
      }
    }
    return entries;
  }

  /** Get: by ID, project layer first then global. */
  get(id: string): MemoryEntry {
    validateMemoryId(id);
    for (const layer of [MEMORY_LAYER_PROJECT, MEMORY_LAYER_GLOBAL]) {
      try {
        return this.getInLayer(id, layer);
      } catch {
        // try next
      }
    }
    throw new Error(`memory "${id}" not found`);
  }

  getInLayer(id: string, layer: string): MemoryEntry {
    validateMemoryId(id);
    if (!validMemoryLayer(layer)) throw new Error(`invalid memory layer: "${layer}"`);
    const abs = join(this.dirForLayer(layer), memoryFileName(id));
    if (!existsSync(abs)) throw new Error(`memory "${id}" not found in ${layer} layer`);
    return this.parseFile(abs, layer);
  }

  /** ResolveReferenceTarget: a real ID, or a unique title-slug match. */
  resolveReferenceTarget(target: string): MemoryEntry {
    try {
      return this.get(target);
    } catch {
      // fall through to the slug lookup
    }
    const wanted = goTrimSpace(target);
    if (wanted === "") throw new Error(`memory "${wanted}" not found`);
    let match: MemoryEntry | undefined;
    for (const layer of [MEMORY_LAYER_PROJECT, MEMORY_LAYER_GLOBAL]) {
      for (const entry of this.list(layer)) {
        if (slugifyReferenceTitle(entry.title) !== wanted) continue;
        if (match) throw new Error(`memory ref "${wanted}" is ambiguous`);
        match = entry;
      }
    }
    if (!match) throw new Error(`memory "${wanted}" not found`);
    return match;
  }

  async create(entry: MemoryEntry): Promise<void> {
    if (!entry) throw new Error("memory entry is required");
    validateNewMemoryCategory(entry.category ?? "");
    if (entry.layer === "") entry.layer = MEMORY_LAYER_PROJECT;
    if (!validMemoryLayer(entry.layer)) throw new Error(`invalid memory layer: "${entry.layer}"`);
    if (entry.id === "") entry.id = newTaskId();
    validateMemoryId(entry.id);
    memoryApplyLifecycleDefaults(entry);
    const now = new Date().toISOString();
    if (isZeroTime(entry.createdAt)) entry.createdAt = now;
    if (isZeroTime(entry.updatedAt)) entry.updatedAt = now;
    const dir = this.dirForLayer(entry.layer);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const abs = join(dir, memoryFileName(entry.id));
    await this.store.withMemoryLock(entry.id, () => atomicWrite(abs, renderMemory(entry)));
  }

  /** Update: overwrite an existing entry (touching updatedAt). */
  update(entry: MemoryEntry): Promise<void> {
    if (!entry) return Promise.reject(new Error("memory entry is required"));
    if (entry.id === "") return Promise.reject(new Error("memory ID is required"));
    validateMemoryId(entry.id);
    return this.store.withMemoryLock(entry.id, () => {
      const existing = this.get(entry.id);
      validateLegacyDecisionMemoryUpdate(existing, entry);
      this.writeExisting(entry, existing, true);
    });
  }

  /** UpdateContentPreservingTimestamp: a mechanical reformat that keeps updatedAt. */
  updateContentPreservingTimestamp(entry: MemoryEntry): Promise<void> {
    if (!entry || entry.id === "") return Promise.reject(new Error("memory entry is required"));
    validateMemoryId(entry.id);
    return this.store.withMemoryLock(entry.id, () => {
      const existing = this.get(entry.id);
      validateLegacyDecisionMemoryUpdate(existing, entry);
      entry.updatedAt = existing.updatedAt;
      this.writeExisting(entry, existing, false);
    });
  }

  restoreLegacyDecisionMigration(
    entry: MemoryEntry,
    expected: MemoryEntry | undefined,
    migrationId: string,
  ): Promise<void> {
    if (!entry || entry.id === "" || goTrimSpace(migrationId) === "") {
      return Promise.reject(new Error("memory snapshot and migration ID are required"));
    }
    return this.store.withMemoryLock(entry.id, () => {
      const existing = this.get(entry.id);
      if (existing.metadata?.[LEGACY_DECISION_MIGRATION_ID_KEY] !== migrationId) {
        if (migrationEqual(existing, entry)) return;
        throw new Error(`memory "${entry.id}" is not owned by migration "${migrationId}"`);
      }
      if (!expected || !migrationEqual(existing, expected)) {
        throw new Error(
          `memory "${entry.id}" changed after migration "${migrationId}"; automatic rollback is unsafe`,
        );
      }
      if (!isLegacyDecisionMemoryCategory(entry.category ?? "")) {
        throw new Error(
          `migration snapshot for memory "${entry.id}" is not a legacy Decision Memory`,
        );
      }
      this.writeExisting(entry, existing, false);
    });
  }

  /** writeExisting: replace an entry in place under the caller's lock (history rollback seam). */
  writeExisting(entry: MemoryEntry, existing: MemoryEntry, touch: boolean): void {
    validateMemoryId(entry.id);
    if (touch) entry.updatedAt = new Date().toISOString();
    if (isZeroTime(entry.createdAt)) entry.createdAt = existing.createdAt;
    memoryApplyLifecycleDefaults(entry);
    const dir = this.dirForLayer(existing.layer);
    atomicWrite(join(dir, memoryFileName(entry.id)), renderMemory(entry));
  }

  delete(id: string): Promise<void> {
    validateMemoryId(id);
    return this.store.withMemoryLock(id, () => {
      try {
        const entry = this.get(id);
        if (isLegacyDecisionMemoryCategory(entry.category ?? "")) {
          throw new Error(LEGACY_DECISION_MEMORY_WRITE_ERROR);
        }
      } catch (e) {
        if ((e as Error).message === LEGACY_DECISION_MEMORY_WRITE_ERROR) throw e;
      }
      const filename = memoryFileName(id);
      for (const dir of [this.projectDir(), this.globalDir()]) {
        const abs = join(dir, filename);
        if (existsSync(abs)) {
          rmSync(abs);
          return;
        }
      }
      throw new Error(`memory "${id}" not found`);
    });
  }

  promote(id: string): Promise<MemoryEntry> {
    return this.shift(id, "promote");
  }
  demote(id: string): Promise<MemoryEntry> {
    return this.shift(id, "demote");
  }
  promotePersistent(id: string): Promise<MemoryEntry> {
    return this.shift(id, "promote");
  }
  demotePersistent(id: string): Promise<MemoryEntry> {
    return this.shift(id, "demote");
  }

  private shift(id: string, dir: "promote" | "demote"): Promise<MemoryEntry> {
    const entry = this.get(id);
    const next = dir === "promote" ? promoteLayer(entry.layer) : demoteLayer(entry.layer);
    if (next === undefined) {
      return Promise.reject(
        new Error(
          dir === "promote"
            ? `cannot promote: already at top layer (${entry.layer})`
            : `cannot demote: already at bottom layer (${entry.layer})`,
        ),
      );
    }
    return this.moveLayer(entry, next);
  }

  private moveLayer(entry: MemoryEntry, newLayer: string): Promise<MemoryEntry> {
    validateMemoryId(entry.id);
    return this.store.withMemoryLock(entry.id, () => {
      const current = this.get(entry.id);
      if (isLegacyDecisionMemoryCategory(current.category ?? "")) {
        throw new Error(LEGACY_DECISION_MEMORY_WRITE_ERROR);
      }
      const oldDir = this.dirForLayer(current.layer);
      const newDir = this.dirForLayer(newLayer);
      mkdirSync(newDir, { recursive: true, mode: 0o755 });
      const filename = memoryFileName(current.id);
      current.layer = newLayer;
      current.updatedAt = new Date().toISOString();
      atomicWrite(join(newDir, filename), renderMemory(current));
      rmSync(join(oldDir, filename), { force: true });
      return current;
    });
  }

  countByLayer(layer: string): number {
    return readDirSorted(this.dirForLayer(layer)).filter(
      (e) => !e.isDirectory() && e.name.startsWith("memory-") && e.name.endsWith(".md"),
    ).length;
  }

  parseFile(abs: string, layer: string): MemoryEntry {
    let data: string;
    try {
      data = readFileSync(abs, "utf8");
    } catch (e) {
      throw new Error(`parseFile ${abs}: ${(e as Error).message}`);
    }
    return parseMemoryContent(data, layer);
  }
}
