// Task and Doc state as history sees it: snapshots, canonical hashes, change tracking, markdown
// section handling and replay. Ports of the pure parts of version_store.go and history_adapter.go.
import { randomBytes } from "node:crypto";
import type { Doc } from "../../models/doc.ts";
import type { MemoryEntry } from "../../models/memory.ts";
import type { AcceptanceCriterion, Task } from "../../models/task.ts";
import type {
  DocChange,
  DocChangeScope,
  DocVersion,
  DocVersionHistory,
  HistoryRecord,
  TaskChange,
  TaskVersion,
  TaskVersionHistory,
} from "../../models/version.ts";
import { goTrimSpace } from "../core/util.ts";
import {
  type AnyMap,
  cloneJson,
  firstNonEmpty,
  firstPositive,
  goDeepEqual,
  goMarshal,
  goTime,
  normalizeAny,
  sha256Hex,
} from "./go-json.ts";
import {
  HistoryCorruptError,
  LIFECYCLE_OPERATION_DELETE,
  LIFECYCLE_OPERATION_RESTORE,
} from "./records.ts";

// --- doc paths and ids -------------------------------------------------------------------------

/** normalizeDocPath: trim, drop a leading "/" and ".md", trim "/". */
export function normalizeDocPath(path: string): string {
  let p = goTrimSpace(path);
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith(".md")) p = p.slice(0, -3);
  return p.replace(/^\/+|\/+$/g, "");
}

/** canonicalDocHistoryPath: undo a reconciler's store-relative `docs/<path>.md` shape. */
export function canonicalDocHistoryPath(path: string): string {
  let trimmed = goTrimSpace(path.replaceAll("\\", "/"));
  if (trimmed.startsWith("docs/") && trimmed.endsWith(".md")) {
    trimmed = trimmed.slice("docs/".length, -3);
  }
  return trimmed;
}

/** normalizeHistoryDocPath: accept both `docs/x.md` and `x`. */
export function normalizeHistoryDocPath(path: string): string {
  let p = goTrimSpace(path);
  if (p.startsWith("/")) p = p.slice(1);
  if (p.startsWith("docs/")) p = p.slice("docs/".length);
  return normalizeDocPath(p);
}

export function compactDocPaths(...paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const p = normalizeDocPath(raw);
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function legacyDocId(docPath: string): string {
  return `legacy-${sha256Hex(`legacy-doc:${normalizeDocPath(docPath)}`).slice(0, 16)}`;
}

/** newDocID: `doc-` plus 32 hex characters. */
export function newDocId(): string {
  return `doc-${randomBytes(16).toString("hex")}`;
}

// --- Doc state ---------------------------------------------------------------------------------

/** The slice of a Doc history tracks. `tags` undefined is a nil slice in Go terms. */
export interface DocState {
  id: string;
  path: string;
  title: string;
  description: string;
  content: string;
  tags: string[] | undefined;
}

export function docStateOf(doc: Partial<Doc> & { path: string }): DocState {
  return {
    id: doc.id ?? "",
    path: doc.path,
    title: doc.title ?? "",
    description: doc.description ?? "",
    content: doc.content ?? "",
    tags: doc.tags === null ? undefined : doc.tags,
  };
}

export function cloneDocState(doc: DocState): DocState {
  return { ...doc, tags: doc.tags === undefined ? undefined : [...doc.tags] };
}

/** canonicalDocContent. */
export function canonicalDocContent(content: string): string {
  return goTrimSpace(content);
}

/** rawDocSnapshot: the pre-canonicalisation shape, kept to recognise older hashes. */
export function rawDocSnapshot(doc: DocState): AnyMap {
  const snap: AnyMap = { path: normalizeDocPath(doc.path), title: doc.title };
  if (doc.id !== "") snap.id = doc.id;
  if (doc.description !== "") snap.description = doc.description;
  if (doc.content !== "") snap.content = doc.content;
  if (doc.tags && doc.tags.length > 0) snap.tags = [...doc.tags];
  return snap;
}

/** DocToSnapshot. */
export function docToSnapshot(doc: DocState): AnyMap {
  const snap = rawDocSnapshot(doc);
  if (typeof snap.content === "string") {
    const canonical = canonicalDocContent(snap.content);
    if (canonical !== "") snap.content = canonical;
    else delete snap.content;
  }
  return snap;
}

/** hashSnapshot: SHA-256 of the key-sorted compact JSON; "" for an empty snapshot. */
export function hashSnapshot(snapshot: AnyMap | null | undefined): string {
  if (!snapshot || Object.keys(snapshot).length === 0) return "";
  return sha256Hex(goMarshal(snapshot, true));
}

export function hashDoc(doc: DocState | null | undefined): string {
  return doc ? hashSnapshot(docToSnapshot(doc)) : "";
}

/** CanonicalDocHash. */
export function canonicalDocHash(
  doc: (Partial<Doc> & { path: string }) | null | undefined,
): string {
  return doc ? hashDoc(docStateOf(doc)) : "";
}

/**
 * docHashRecognized: a recorded hash still describes this state, either canonically or as the
 * untrimmed body older writers hashed.
 */
export function docHashRecognized(recorded: string | undefined, state: DocState | null): boolean {
  if (!recorded || !state) return true;
  if (recorded === hashDoc(state)) return true;
  return recorded === hashSnapshot(rawDocSnapshot(state));
}

export function anyStringSlice(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/** applyDocSnapshot. */
export function applyDocSnapshot(state: DocState, snapshot: AnyMap | null | undefined): void {
  if (!snapshot || Object.keys(snapshot).length === 0) return;
  if (typeof snapshot.path === "string" && snapshot.path !== "") {
    state.path = normalizeDocPath(snapshot.path);
  }
  if (typeof snapshot.id === "string") state.id = snapshot.id;
  if (typeof snapshot.title === "string") state.title = snapshot.title;
  if (typeof snapshot.description === "string") state.description = snapshot.description;
  if (typeof snapshot.content === "string") state.content = snapshot.content;
  const tags = anyStringSlice(snapshot.tags);
  if (tags !== undefined) state.tags = tags;
}

// --- Task state --------------------------------------------------------------------------------

/** TaskToSnapshot: the generic map stored in a version, normalized through JSON. */
export function taskToSnapshot(task: Task): AnyMap {
  const snap: AnyMap = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    createdAt: goTime(task.createdAt),
    updatedAt: goTime(task.updatedAt),
    timeSpent: task.timeSpent,
    archived: task.archived,
  };
  if (task.description) snap.description = task.description;
  if (task.assignee) snap.assignee = task.assignee;
  if (task.labels && task.labels.length > 0) snap.labels = [...task.labels];
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    snap.acceptanceCriteria = task.acceptanceCriteria.map((ac) => ({
      text: ac.text,
      completed: ac.completed,
    }));
  }
  if (task.implementationPlan) snap.implementationPlan = task.implementationPlan;
  if (task.implementationNotes) snap.implementationNotes = task.implementationNotes;
  if (task.parent) snap.parent = task.parent;
  if (task.spec) snap.spec = task.spec;
  if (task.fulfills && task.fulfills.length > 0) snap.fulfills = [...task.fulfills];
  if (task.order !== undefined && task.order !== null) snap.order = task.order;
  if (task.completedAt) snap.completedAt = goTime(task.completedAt);
  if (task.archivedAt) snap.archivedAt = goTime(task.archivedAt);
  return normalizeAny(snap);
}

/** taskCanonicalHash: timestamps are transport metadata and do not take part. */
export function taskCanonicalHash(snapshot: AnyMap): string {
  const canonical = cloneJson(snapshot);
  delete canonical.createdAt;
  delete canonical.updatedAt;
  delete canonical.completedAt;
  delete canonical.archivedAt;
  return hashSnapshot(canonical);
}

/** CanonicalTaskHash. */
export function canonicalTaskHash(task: Task | null | undefined): string {
  return task ? taskCanonicalHash(taskToSnapshot(task)) : "";
}

/**
 * CanonicalMemoryHash: the complete persisted memory state. The derived lifecycle warning field is
 * excluded. Go's memory parser turns absent sources/tags into empty (not nil) slices, which marshal
 * as `[]`; only a slice that was never set (undefined here) is `null`.
 */
export function canonicalMemoryHash(memory: MemoryEntry | null | undefined): string {
  if (!memory) return "";
  const list = (v: readonly string[] | undefined) => (v ? [...v] : null);
  // Go distinguishes a nil map (`null`) from an empty one (`{}`); the parser keeps an explicit `metadata: {}`.
  const meta = memory.metadata ?? null;
  return hashSnapshot(
    normalizeAny({
      id: memory.id,
      title: memory.title,
      layer: memory.layer,
      category: memory.category ?? "",
      content: memory.content ?? "",
      status: memory.status ?? "",
      confidence: memory.confidence ?? "",
      lastVerified: goTime(memory.lastVerified),
      ttlDays: memory.ttlDays ?? 0,
      sources: list(memory.sources),
      mergedInto: memory.mergedInto ?? "",
      rejectedReason: memory.rejectedReason ?? "",
      tags: list(memory.tags),
      metadata: meta,
      createdAt: goTime(memory.createdAt),
      updatedAt: goTime(memory.updatedAt),
    }),
  );
}

export function isZeroValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (typeof v === "number") return v === 0;
  if (typeof v === "boolean") return !v;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function acList(list: readonly AcceptanceCriterion[] | null | undefined) {
  return list ? list.map((ac) => ({ text: ac.text, completed: ac.completed })) : undefined;
}

/** TrackChanges: the field mutations between two Tasks; `oldTask` null means creation. */
export function trackTaskChanges(oldTask: Task | null, newTask: Task): TaskChange[] {
  const changes: TaskChange[] = [];
  if (oldTask === null) {
    if (newTask.status) changes.push({ field: "status", oldValue: null, newValue: newTask.status });
    if (newTask.priority) {
      changes.push({ field: "priority", oldValue: null, newValue: newTask.priority });
    }
    return changes;
  }
  const diff = (field: string, a: unknown, b: unknown, zeroable = true) => {
    if (goDeepEqual(a, b)) return;
    const change: TaskChange = { field, oldValue: null, newValue: null };
    if (!zeroable || !isZeroValue(a)) change.oldValue = a ?? null;
    if (!zeroable || !isZeroValue(b)) change.newValue = b ?? null;
    changes.push(change);
  };
  const str = (v: string | undefined) => v ?? "";
  diff("title", str(oldTask.title), str(newTask.title));
  diff("status", str(oldTask.status), str(newTask.status));
  diff("priority", str(oldTask.priority), str(newTask.priority));
  diff("assignee", str(oldTask.assignee), str(newTask.assignee));
  diff("labels", oldTask.labels, newTask.labels);
  diff("description", str(oldTask.description), str(newTask.description));
  diff(
    "acceptanceCriteria",
    acList(oldTask.acceptanceCriteria),
    acList(newTask.acceptanceCriteria),
  );
  diff("implementationPlan", str(oldTask.implementationPlan), str(newTask.implementationPlan));
  diff("implementationNotes", str(oldTask.implementationNotes), str(newTask.implementationNotes));
  diff("parent", str(oldTask.parent), str(newTask.parent));
  diff("spec", str(oldTask.spec), str(newTask.spec));
  diff("fulfills", oldTask.fulfills, newTask.fulfills);
  // Pointer fields: a nil pointer is never "zero", it just marshals as null.
  diff("order", oldTask.order, newTask.order, false);
  diff("completedAt", goTimeOpt(oldTask.completedAt), goTimeOpt(newTask.completedAt), false);
  diff("archivedAt", goTimeOpt(oldTask.archivedAt), goTimeOpt(newTask.archivedAt), false);
  diff("archived", oldTask.archived, newTask.archived);
  diff("timeSpent", oldTask.timeSpent, newTask.timeSpent);
  return changes;
}

function goTimeOpt(ts: string | undefined): string | undefined {
  return ts === undefined || ts === "" ? undefined : goTime(ts);
}

/** normalizeStateMap. */
export function normalizeStateMap(state: AnyMap): AnyMap {
  return normalizeAny(state);
}

/** applyTaskChangesToMap: replay task deltas onto a snapshot-shaped state. */
export function applyTaskChangesToMap(
  state: AnyMap,
  changes: readonly TaskChange[] | null | undefined,
): AnyMap {
  for (const change of changes ?? []) {
    if (change.newValue === null || change.newValue === undefined) {
      switch (change.field) {
        case "title":
        case "status":
        case "priority":
          state[change.field] = "";
          break;
        case "timeSpent":
          state[change.field] = 0;
          break;
        case "archived":
          state[change.field] = false;
          break;
        default:
          delete state[change.field];
      }
    } else {
      state[change.field] = cloneJson(normalizeAny(change.newValue));
    }
  }
  return normalizeStateMap(state);
}

/** historyDeltaInefficient: a checkpoint when the delta is at least as large as the snapshot. */
export function historyDeltaInefficient(
  delta: unknown,
  snapshot: AnyMap | null | undefined,
): boolean {
  const deltaBytes = Buffer.byteLength(goMarshal(delta ?? null, false));
  const snapshotBytes = Buffer.byteLength(goMarshal(snapshot ?? null, false));
  return snapshotBytes === 0 || deltaBytes >= snapshotBytes;
}

// --- markdown sections -------------------------------------------------------------------------

export interface MarkdownSection {
  index: number;
  level: number;
  title: string;
  text: string;
  start: number;
  end: number;
}

export function headingLevel(line: string): number {
  if (!line.startsWith("#")) return 0;
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level === 0) return 0;
  if (line.length > level && line[level] !== " ") return 0;
  return level;
}

export function docMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("#")) return;
    const level = headingLevel(line);
    if (level === 0) return;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = headingLevel(lines[j] as string);
      if (next > 0 && next <= level) {
        end = j;
        break;
      }
    }
    const title = goTrimSpace(line.slice(level));
    if (title === "") return;
    sections.push({
      index: sections.length + 1,
      level,
      title,
      text: goTrimSpace(lines.slice(i, end).join("\n")),
      start: i,
      end,
    });
  });
  return sections;
}

export function findMarkdownSection(
  content: string,
  sectionRef: string,
): MarkdownSection | undefined {
  const sections = docMarkdownSections(content);
  if (sections.length === 0) return undefined;
  const ref = goTrimSpace(sectionRef.replace(/^[# ]+/, ""));
  const lowerRef = ref.toLowerCase();
  return sections.find(
    (s) =>
      String(s.index) === ref ||
      s.title.toLowerCase() === lowerRef ||
      s.title.toLowerCase().includes(lowerRef),
  );
}

export function replaceMarkdownSection(
  content: string,
  sectionRef: string,
  sectionContent: string,
): { content: string; replaced: boolean } {
  const section = findMarkdownSection(content, sectionRef);
  if (!section) return { content, replaced: false };
  const lines = content.split("\n");
  const replacement = sectionContent.split("\n");
  const current = lines.slice(section.start, section.end);
  for (let i = current.length - 1; i >= 0 && goTrimSpace(current[i] as string) === ""; i--) {
    if (
      replacement.length === 0 ||
      goTrimSpace(replacement[replacement.length - 1] as string) !== ""
    ) {
      replacement.push("");
    }
  }
  const result = [...lines.slice(0, section.start), ...replacement, ...lines.slice(section.end)];
  return { content: result.join("\n"), replaced: true };
}

// --- doc change scopes -------------------------------------------------------------------------

const byteLen = (s: string) => Buffer.byteLength(s);

function valueByteLen(value: unknown): number {
  if (isZeroValue(value)) return 0;
  return byteLen(goMarshal(value, false));
}

export function fieldDocChangeScope(
  field: string,
  oldValue: unknown,
  newValue: unknown,
): DocChangeScope {
  const oldBytes = valueByteLen(oldValue);
  const newBytes = valueByteLen(newValue);
  return {
    type: field === "path" ? "path" : "field",
    field,
    summary: field,
    oldBytes,
    newBytes,
    deltaBytes: newBytes - oldBytes,
  };
}

export function wholeDocChangeScope(oldContent: string, newContent: string): DocChangeScope {
  const oldBytes = byteLen(oldContent);
  const newBytes = byteLen(newContent);
  return {
    type: "whole_doc",
    field: "content",
    summary: "Whole document content",
    oldBytes,
    newBytes,
    deltaBytes: newBytes - oldBytes,
  };
}

export function sectionDocChangeScope(
  section: string,
  oldContent: string,
  newContent: string,
): DocChangeScope {
  const oldBytes = byteLen(oldContent);
  const newBytes = byteLen(newContent);
  return {
    type: "section",
    field: "content",
    section,
    summary: `Section: ${section}`,
    oldBytes,
    newBytes,
    deltaBytes: newBytes - oldBytes,
  };
}

/** docChangeScopes: derive scopes for changes that were stored without any. */
export function docChangeScopes(
  changes: readonly DocChange[] | null | undefined,
): DocChangeScope[] {
  if (!changes || changes.length === 0) return [];
  const seen = new Set<string>();
  const scopes: DocChangeScope[] = [];
  const add = (scope: DocChangeScope) => {
    const key = `${scope.type}:${scope.field ?? ""}:${scope.section ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push(scope);
  };
  for (const change of changes) {
    if (change.field === "content") {
      add({ type: "whole_doc", field: "content", summary: "Whole document content" });
    } else if (change.field === "path") {
      add({ type: "path", field: "path", summary: "Document path" });
    } else {
      add({ type: "field", field: change.field, summary: change.field });
    }
  }
  return scopes;
}

export function dedupeDocChanges(changes: DocChange[]): DocChange[] {
  if (changes.length <= 1) return changes;
  const seen = new Set<string>();
  return changes.filter((c) => {
    if (seen.has(c.field)) return false;
    seen.add(c.field);
    return true;
  });
}

export function dedupeDocChangeScopes(scopes: DocChangeScope[]): DocChangeScope[] {
  if (scopes.length <= 1) return scopes;
  const seen = new Set<string>();
  return scopes.filter((s) => {
    const key = `${s.type}:${s.field ?? ""}:${s.section ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface DocContentScope {
  scope?: DocChangeScope;
  old: string;
  new: string;
  ok: boolean;
}

export function resolveContentChangeScope(
  oldContent: string,
  newContent: string,
  sectionRef: string,
): DocContentScope {
  const none: DocContentScope = { old: "", new: "", ok: false };
  if (sectionRef !== "") {
    const oldSection = findMarkdownSection(oldContent, sectionRef);
    const newSection = findMarkdownSection(newContent, sectionRef);
    if (oldSection && newSection) {
      const title = firstNonEmpty(newSection.title, oldSection.title, goTrimSpace(sectionRef));
      const scope: DocContentScope = {
        scope: sectionDocChangeScope(title, oldSection.text, newSection.text),
        old: oldSection.text,
        new: newSection.text,
        ok: true,
      };
      const rebuilt = replaceMarkdownSection(oldContent, title, newSection.text);
      if (rebuilt.replaced && rebuilt.content === newContent) return scope;
    }
  }
  const oldSections = docMarkdownSections(oldContent);
  const newSections = docMarkdownSections(newContent);
  if (oldSections.length === 0 || oldSections.length !== newSections.length) return none;
  let changed = -1;
  for (let i = 0; i < oldSections.length; i++) {
    const a = oldSections[i] as MarkdownSection;
    const b = newSections[i] as MarkdownSection;
    if (a.level !== b.level || a.title.toLowerCase() !== b.title.toLowerCase()) return none;
    if (a.text !== b.text) {
      if (changed !== -1) return none;
      changed = i;
    }
  }
  if (changed === -1) return none;
  const a = oldSections[changed] as MarkdownSection;
  const b = newSections[changed] as MarkdownSection;
  return {
    scope: sectionDocChangeScope(b.title, a.text, b.text),
    old: a.text,
    new: b.text,
    ok: true,
  };
}

export interface DocRevisionTrackOptions {
  section?: string;
}

/** trackDocChangesWithOptions. `oldDoc` null means creation. */
export function trackDocChanges(
  oldDoc: DocState | null,
  newDoc: DocState,
  opts: DocRevisionTrackOptions = {},
): { changes: DocChange[]; scopes: DocChangeScope[]; contentScope: DocContentScope } {
  const changes: DocChange[] = [];
  const scopes: DocChangeScope[] = [];
  let contentScope: DocContentScope = { old: "", new: "", ok: false };
  const add = (change: DocChange, scope: DocChangeScope) => {
    changes.push(change);
    scopes.push(scope);
  };
  if (oldDoc === null) {
    if (newDoc.id !== "") {
      add(
        { field: "id", oldValue: null, newValue: newDoc.id },
        fieldDocChangeScope("id", "", newDoc.id),
      );
    }
    if (newDoc.path !== "") {
      const value = normalizeDocPath(newDoc.path);
      add(
        { field: "path", oldValue: null, newValue: value },
        fieldDocChangeScope("path", "", value),
      );
    }
    if (newDoc.title !== "") {
      add(
        { field: "title", oldValue: null, newValue: newDoc.title },
        fieldDocChangeScope("title", "", newDoc.title),
      );
    }
    if (newDoc.description !== "") {
      add(
        { field: "description", oldValue: null, newValue: newDoc.description },
        fieldDocChangeScope("description", "", newDoc.description),
      );
    }
    if (newDoc.content !== "") {
      const scope = wholeDocChangeScope("", newDoc.content);
      contentScope = { scope, old: "", new: newDoc.content, ok: true };
      add({ field: "content", oldValue: null, newValue: newDoc.content }, scope);
    }
    if (newDoc.tags && newDoc.tags.length > 0) {
      add(
        { field: "tags", oldValue: null, newValue: newDoc.tags },
        fieldDocChangeScope("tags", null, newDoc.tags),
      );
    }
    return {
      changes: dedupeDocChanges(changes),
      scopes: dedupeDocChangeScopes(scopes),
      contentScope,
    };
  }
  const diff = (field: string, a: unknown, b: unknown) => {
    if (goDeepEqual(a, b)) return;
    const change: DocChange = { field, oldValue: null, newValue: null };
    if (!isZeroValue(a)) change.oldValue = a;
    if (!isZeroValue(b)) change.newValue = b;
    add(change, fieldDocChangeScope(field, a, b));
  };
  diff("path", normalizeDocPath(oldDoc.path), normalizeDocPath(newDoc.path));
  diff("id", oldDoc.id, newDoc.id);
  diff("title", oldDoc.title, newDoc.title);
  diff("description", oldDoc.description, newDoc.description);
  if (oldDoc.content !== newDoc.content) {
    contentScope = resolveContentChangeScope(oldDoc.content, newDoc.content, opts.section ?? "");
    if (contentScope.ok && contentScope.scope?.type === "section") {
      add(
        { field: "content", oldValue: contentScope.old, newValue: contentScope.new },
        contentScope.scope,
      );
    } else {
      const scope = wholeDocChangeScope(oldDoc.content, newDoc.content);
      contentScope = { scope, old: oldDoc.content, new: newDoc.content, ok: true };
      add({ field: "content", oldValue: oldDoc.content, newValue: newDoc.content }, scope);
    }
  }
  diff("tags", oldDoc.tags, newDoc.tags);
  return {
    changes: dedupeDocChanges(changes),
    scopes: dedupeDocChangeScopes(scopes),
    contentScope,
  };
}

// --- replay ------------------------------------------------------------------------------------

export function firstSectionScopeOf(scopes: readonly DocChangeScope[] | null | undefined): string {
  for (const scope of scopes ?? []) {
    if (scope.type === "section" && scope.field === "content" && scope.section)
      return scope.section;
  }
  return "";
}

/** applyDocChangesToState. */
export function applyDocChangesToState(state: DocState, record: HistoryRecord): void {
  const section = firstSectionScopeOf(record.changedScopes);
  for (const change of record.docChanges ?? []) {
    const nv = change.newValue;
    switch (change.field) {
      case "path":
        if (nv === null || nv === undefined) state.path = "";
        else if (typeof nv === "string") state.path = normalizeDocPath(nv);
        break;
      case "id":
        if (nv === null || nv === undefined) state.id = "";
        else if (typeof nv === "string") state.id = nv;
        break;
      case "title":
        state.title = typeof nv === "string" ? nv : "";
        break;
      case "description":
        state.description = typeof nv === "string" ? nv : "";
        break;
      case "content":
        if (section !== "") {
          const r = replaceMarkdownSection(
            state.content,
            section,
            typeof nv === "string" ? nv : "",
          );
          if (!r.replaced) throw new HistoryCorruptError(`section "${section}" cannot be replayed`);
          state.content = r.content;
        } else {
          state.content = typeof nv === "string" ? nv : "";
        }
        break;
      case "tags":
        state.tags = anyStringSlice(nv);
        break;
    }
  }
  if (record.currentPath) state.path = normalizeHistoryDocPath(record.currentPath);
}

/**
 * lifecycleCheckpointDroppedContent: a delete or restore checkpoint written from a display
 * snapshot lost its content. The payload has no content key while the prior replayed state, which
 * the record's BaseHash proves it was taken from, still has some.
 */
export function lifecycleCheckpointDroppedContent(
  record: HistoryRecord,
  prior: DocState | null,
): boolean {
  if (
    record.operation !== LIFECYCLE_OPERATION_DELETE &&
    record.operation !== LIFECYCLE_OPERATION_RESTORE
  ) {
    return false;
  }
  if (record.checkpointPayload && Object.hasOwn(record.checkpointPayload, "content")) return false;
  if (!prior || prior.content === "" || !record.baseHash) return false;
  return docHashRecognized(record.baseHash, prior);
}

function listOrNull<T>(list: readonly T[] | undefined): T[] | null {
  return list && list.length > 0 ? list.map((x) => cloneJson(x)) : null;
}

function listOrUndef<T>(list: readonly T[] | undefined): T[] | undefined {
  return list && list.length > 0 ? list.map((x) => cloneJson(x)) : undefined;
}

export function logicalVersionOf(record: HistoryRecord): number {
  return firstPositive(record.legacyRevision, record.revision);
}

/** taskHistoryFromRecords: replay a Task stream and verify every canonical hash. */
export function taskHistoryFromRecords(
  taskId: string,
  records: readonly HistoryRecord[],
): TaskVersionHistory {
  const history: TaskVersionHistory = { taskId, currentVersion: 0, versions: [] };
  let state: AnyMap = {};
  for (const record of records) {
    if (record.entityType !== "task" || record.entityId !== taskId) {
      throw new Error(`history entity mismatch for Task "${taskId}"`);
    }
    if (record.checkpoint) state = normalizeStateMap(cloneJson(record.checkpointPayload ?? {}));
    else state = applyTaskChangesToMap(state, record.taskChanges);
    if (record.newHash && !record.legacyUnverified) {
      const computed = taskCanonicalHash(state);
      if (computed !== record.newHash) {
        throw new HistoryCorruptError(
          `Task canonical hash mismatch at revision ${record.revision} (got ${computed} want ${record.newHash})`,
        );
      }
    }
    const version: TaskVersion = {
      id: firstNonEmpty(record.legacyId, `v${logicalVersionOf(record)}`),
      taskId,
      version: logicalVersionOf(record),
      timestamp: record.timestamp,
      changes: listOrNull(record.taskChanges),
      snapshot: cloneJson(state),
    };
    assignDefined(version, {
      author: record.author,
      lifecycleEventId: record.lifecycleEventId,
      schemaVersion: record.schemaVersion,
      baseHash: record.baseHash,
      newHash: record.newHash,
      checkpoint: record.checkpoint,
      source: record.source,
      sessionId: record.sessionId,
      batchId: record.batchId,
      operation: record.operation,
      tombstone: record.tombstone,
      legacyUnverified: record.legacyUnverified,
      legacyPath: record.legacyPath,
      legacyDigest: record.legacyDigest,
    });
    history.versions = [...(history.versions ?? []), version];
  }
  for (const v of history.versions ?? [])
    if (v.version > history.currentVersion) history.currentVersion = v.version;
  return history;
}

/** Copy only fields that are non-zero (Go's `omitempty`). */
export function assignDefined(target: object, fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "" && value !== false && value !== 0) {
      (target as AnyMap)[key] = value;
    }
  }
}

/**
 * replayDocHistory: replay a Doc stream and also return the final replayed state. A caller that
 * persists state, such as a lifecycle tombstone or restore, must use that state and never a
 * version's snapshot: the snapshot is a display projection whose content is dropped after a
 * section-scoped revision, so storing it as a checkpoint yields a record whose NewHash no longer
 * describes its own payload.
 */
export function replayDocHistory(
  docPath: string,
  records: readonly HistoryRecord[],
): { history: DocVersionHistory; state: DocState } {
  const history: DocVersionHistory = {
    docPath,
    currentPath: docPath,
    currentVersion: 0,
    versions: [],
  };
  let state: DocState = {
    id: "",
    path: docPath,
    title: "",
    description: "",
    content: "",
    tags: [],
  };
  const gaps: NonNullable<DocVersionHistory["retentionGaps"]> = [];
  for (const record of records) {
    if (record.entityType !== "doc")
      throw new Error(`history entity mismatch for Doc "${docPath}"`);
    if (record.checkpoint) {
      const prior = state;
      state = { id: "", path: "", title: "", description: "", content: "", tags: undefined };
      applyDocSnapshot(state, record.checkpointPayload);
      if (lifecycleCheckpointDroppedContent(record, prior)) state.content = prior.content;
    }
    const version: DocVersion = {
      id: firstNonEmpty(record.legacyId, `v${logicalVersionOf(record)}`),
      docId: record.entityId,
      docPath,
      version: logicalVersionOf(record),
      timestamp: record.timestamp,
      changes: listOrNull(record.docChanges),
      snapshot: record.checkpointPayload ? cloneJson(record.checkpointPayload) : null,
    };
    assignDefined(version, {
      currentPath: record.currentPath,
      previousPath: record.previousPath,
      author: record.author,
      actor: record.actor,
      source: record.source,
      auditEventId: record.auditEventId,
      sessionId: record.sessionId,
      baseHash: record.baseHash,
      newHash: record.newHash,
      checkpoint: record.checkpoint,
      schemaVersion: record.schemaVersion,
      batchId: record.batchId,
      operation: record.operation,
      tombstone: record.tombstone,
      legacyUnverified: record.legacyUnverified,
      legacyPath: record.legacyPath,
      legacyDigest: record.legacyDigest,
    });
    const scopes = listOrUndef(record.changedScopes);
    if (scopes) version.changedScopes = scopes;
    if (!record.checkpoint) applyDocChangesToState(state, record);
    if (!record.legacyUnverified && !docHashRecognized(record.newHash, state)) {
      throw new HistoryCorruptError(`Doc canonical hash mismatch at revision ${record.revision}`);
    }
    // Keep the replayed snapshot byte-faithful to the record: canonicalising here would erase
    // the pre-canonicalisation body a legacy NewHash covers.
    version.snapshot = rawDocSnapshot(state);
    if (!record.checkpoint && firstSectionScopeOf(record.changedScopes) !== "") {
      delete version.snapshot.content;
    }
    history.versions = [...(history.versions ?? []), version];
    gaps.push(...(record.retentionGaps ?? []));
    history.docId = record.entityId;
    history.currentPath = firstNonEmpty(record.currentPath, history.currentPath);
    history.docPath = history.currentPath;
  }
  if (gaps.length > 0) history.retentionGaps = gaps;
  for (const v of history.versions ?? [])
    if (v.version > history.currentVersion) history.currentVersion = v.version;
  return { history, state };
}

export function docHistoryFromRecords(
  docPath: string,
  records: readonly HistoryRecord[],
): DocVersionHistory {
  return replayDocHistory(docPath, records).history;
}

export { applyDocChangesToState as applyDocChanges };

/** applyDocVersionState: legacy (pre-JSONL) version replay. */
export function applyDocVersionState(state: DocState, version: DocVersion): void {
  applyDocSnapshot(state, version.snapshot);
  const section = firstSectionScopeOf(version.changedScopes);
  for (const change of version.changes ?? []) {
    const nv = change.newValue;
    switch (change.field) {
      case "path":
        if (typeof nv === "string" && nv !== "") state.path = normalizeDocPath(nv);
        else if (version.currentPath) state.path = normalizeDocPath(version.currentPath);
        break;
      case "id":
        if (typeof nv === "string") state.id = nv;
        break;
      case "title":
        if (typeof nv === "string") state.title = nv;
        break;
      case "description":
        if (typeof nv === "string") state.description = nv;
        break;
      case "content":
        if (section !== "") {
          if (typeof nv === "string") {
            const r = replaceMarkdownSection(state.content, section, nv);
            if (r.replaced) state.content = r.content;
          }
        } else if (typeof nv === "string") {
          state.content = nv;
        }
        break;
      case "tags":
        state.tags = anyStringSlice(nv);
        break;
    }
  }
  if (version.currentPath) {
    state.path = normalizeDocPath(canonicalDocHistoryPath(version.currentPath));
  }
}

/** resolveDocStateFromHistory: the state a revision represents; "" resolves the latest. */
export function resolveDocStateFromHistory(
  h: DocVersionHistory | null,
  revisionId: string,
): DocState {
  const versions = h?.versions ?? [];
  if (!h || versions.length === 0) throw new Error("doc history is empty");
  const target = goTrimSpace(revisionId);
  const state: DocState = {
    id: "",
    path: firstNonEmpty(h.docPath, h.currentPath),
    title: "",
    description: "",
    content: "",
    tags: [],
  };
  let last: DocState | undefined;
  for (const version of versions) {
    applyDocVersionState(state, version);
    const clone = cloneDocState(state);
    last = clone;
    if (target === "") continue;
    if (
      version.id === target ||
      String(version.version) === target ||
      `v${version.version}` === target
    ) {
      return clone;
    }
  }
  if (target === "" && last) return last;
  throw new Error(`revision "${revisionId}" not found`);
}

export function findDocVersionIndex(h: DocVersionHistory | null, revisionId: string): number {
  const versions = h?.versions ?? [];
  if (!h || versions.length === 0) throw new Error("doc history is empty");
  const target = goTrimSpace(revisionId);
  if (target === "") return versions.length - 1;
  const idx = versions.findIndex(
    (v) => v.id === target || String(v.version) === target || `v${v.version}` === target,
  );
  if (idx < 0) throw new Error(`revision "${revisionId}" not found`);
  return idx;
}

/** historyRevisionMatches. */
export function historyRevisionMatches(id: string, version: number, requested: string): boolean {
  let req = goTrimSpace(requested);
  if (req === "") return false;
  if (req === id || req === `v${version}` || req === String(version)) return true;
  if (req.startsWith("v")) req = req.slice(1);
  return /^[+-]?\d+$/.test(req) && Number.parseInt(req, 10) === version;
}
