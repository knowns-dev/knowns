// Port of internal/storage/doc_store.go: docs in .knowns/docs/ and .knowns/imports/*/docs/.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Doc } from "../../models/doc.ts";
import { resolveSafe } from "../core/safe-path.ts";
import { atomicWrite, goTrimSpace, splitFrontmatter } from "../core/util.ts";
import { canonicalDocHash, newDocId } from "../history/entities.ts";
import {
  asInt,
  asStr,
  asStrField,
  asStrList,
  formatIso,
  parseYamlMap,
  readDirSorted,
  readTime,
  yamlScalar,
} from "./internal.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { TaskStore } from "./task-store.ts";

export { newDocId };

function toSlash(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** resolveDocPath: the canonical doc path (no `.md`) and its absolute file. */
export function resolveDocPath(root: string, path: string): { path: string; abs: string } {
  const bare = path.endsWith(".md") ? path.slice(0, -3) : path;
  if (goTrimSpace(bare) === "") throw new Error("doc path is required");
  let abs: string;
  try {
    abs = resolveSafe(root, `${bare.replaceAll("\\", "/")}.md`);
  } catch (e) {
    throw new Error(`invalid doc path "${bare}": ${(e as Error).message}`);
  }
  const rel = toSlash(relative(root, abs));
  return { path: rel.endsWith(".md") ? rel.slice(0, -3) : rel, abs };
}

/** parseDocContent: a doc's markdown into a Doc (without canonicalHash). */
export function parseDocContent(
  content: string,
  relPath: string,
  folder: string,
  imported: boolean,
  importSource: string,
): Doc {
  const { yaml, body } = splitFrontmatter(content);
  const doc: Doc = {
    path: relPath,
    title: "",
    createdAt: readTime(""),
    updatedAt: readTime(""),
    content: goTrimSpace(body),
  };
  if (folder !== "") doc.folder = folder;
  if (imported) {
    doc.isImported = true;
    if (importSource !== "") doc.importSource = importSource;
  }
  if (yaml === "") {
    doc.title = relPath.split("/").pop() as string;
    doc.tags = [];
    return doc;
  }
  let fm: Record<string, unknown>;
  try {
    fm = parseYamlMap(yaml);
  } catch (e) {
    throw new Error(`parse doc frontmatter: ${(e as Error).message}`);
  }
  doc.title = asStrField(fm, yaml, "title");
  const id = goTrimSpace(asStrField(fm, yaml, "id"));
  if (id !== "") doc.id = id;
  const description = asStr(fm.description);
  if (description !== "") doc.description = description;
  doc.tags = asStrList(fm.tags);
  if (fm.order !== undefined && fm.order !== null) doc.order = asInt(fm.order);
  doc.createdAt = readTime(asStr(fm.createdAt));
  doc.updatedAt = readTime(asStr(fm.updatedAt));
  return doc;
}

/** renderDoc: the canonical markdown for a doc file. */
export function renderDoc(doc: Doc): string {
  let b = "---\n";
  if (goTrimSpace(doc.id ?? "") !== "") b += `id: ${yamlScalar(doc.id as string)}\n`;
  b += `title: ${yamlScalar(doc.title)}\n`;
  b += `description: ${yamlScalar(doc.description ?? "")}\n`;
  b += `createdAt: '${formatIso(doc.createdAt)}'\n`;
  b += `updatedAt: '${formatIso(doc.updatedAt)}'\n`;
  const tags = doc.tags ?? [];
  if (tags.length === 0) b += "tags: []\n";
  else b += `tags:\n${tags.map((t) => `  - ${t}\n`).join("")}`;
  if (doc.order !== undefined) b += `order: ${doc.order}\n`;
  b += "---\n";
  const content = doc.content ?? "";
  if (content !== "") {
    b += `\n${content}`;
    if (!content.endsWith("\n")) b += "\n";
  }
  return b;
}

// --- markdown sections (the subset of version_store.go the review gate needs) -------------------

function headingLevel(line: string): number {
  if (!line.startsWith("#")) return 0;
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (line.length > level && line[level] !== " ") return 0;
  return level;
}

interface MdSection {
  index: number;
  title: string;
  text: string;
}

function markdownSections(content: string): MdSection[] {
  const lines = content.split("\n");
  const sections: MdSection[] = [];
  lines.forEach((line, i) => {
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
      title,
      text: goTrimSpace(lines.slice(i, end).join("\n")),
    });
  });
  return sections;
}

function findMarkdownSection(content: string, ref: string): MdSection | undefined {
  const sections = markdownSections(content);
  const wanted = goTrimSpace(ref.replace(/^[# ]+/, ""));
  return sections.find(
    (s) =>
      String(s.index) === wanted ||
      s.title.toLowerCase() === wanted.toLowerCase() ||
      s.title.toLowerCase().includes(wanted.toLowerCase()),
  );
}

const docHasTag = (tags: readonly string[], target: string) =>
  tags.some((t) => goTrimSpace(t).toLowerCase() === target.toLowerCase());

/** applyLockedDecisionReviewGate: editing Locked Decisions of an approved spec reopens review. */
export function applyLockedDecisionReviewGate(existing: Doc | undefined, updated: Doc): void {
  if (!existing || !docHasTag(existing.tags ?? [], "approved")) return;
  const before = findMarkdownSection(existing.content ?? "", "Locked Decisions");
  const after = findMarkdownSection(updated.content ?? "", "Locked Decisions");
  if (
    (before === undefined) === (after === undefined) &&
    (before === undefined || goTrimSpace(before.text) === goTrimSpace(after?.text ?? ""))
  ) {
    return;
  }
  const tags = (updated.tags ?? []).filter((t) => goTrimSpace(t).toLowerCase() !== "approved");
  for (const tag of ["draft", "review-required"]) if (!docHasTag(tags, tag)) tags.push(tag);
  updated.tags = tags;
}

const normalizeDocPathForStore = (p: string) =>
  goTrimSpace(p)
    .replace(/\.md$/, "")
    .replace(/^\/+|\/+$/g, "");

export type DocPathRewriter = (content: string, oldPath: string, newPath: string) => string;

export class DocStore {
  readonly root: string;
  constructor(store: { root: string }) {
    this.root = store.root;
  }

  docsDir(): string {
    return join(this.root, "docs");
  }
  importsDir(): string {
    return join(this.root, "imports");
  }

  list(): Doc[] {
    const docs = this.walkDocs(this.docsDir(), "", false, "");
    let imported: Doc[] = [];
    try {
      imported = this.listImported();
    } catch {
      return docs; // non-fatal
    }
    docs.push(...imported);
    validateDocStableIds(docs);
    return docs;
  }

  /** ValidateStableID: reject a duplicate stable identity before a canonical write. */
  validateStableId(id: string, path: string): void {
    const trimmed = goTrimSpace(id);
    if (trimmed === "") return;
    for (const doc of this.list()) {
      if (
        doc.id === trimmed &&
        normalizeDocPathForStore(doc.path) !== normalizeDocPathForStore(path)
      ) {
        throw new Error(
          `ambiguous Doc stable ID "${trimmed}" at paths "${doc.path}" and "${path}"; repair duplicate frontmatter id before mutating`,
        );
      }
    }
  }

  private listImported(): Doc[] {
    const docs: Doc[] = [];
    for (const e of readDirSorted(this.importsDir())) {
      if (!e.isDirectory()) continue;
      try {
        docs.push(...this.walkDocs(join(this.importsDir(), e.name, "docs"), "", true, e.name));
      } catch {
        // skip an unreadable import
      }
    }
    return docs;
  }

  private walkDocs(dir: string, relBase: string, imported: boolean, importSource: string): Doc[] {
    const docs: Doc[] = [];
    for (const e of readDirSorted(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const sub = relBase === "" ? e.name : `${relBase}/${e.name}`;
        try {
          docs.push(...this.walkDocs(full, sub, imported, importSource));
        } catch {
          // skip
        }
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const base = e.name.slice(0, -3);
      const rel = relBase === "" ? base : `${relBase}/${base}`;
      try {
        docs.push(this.parseFile(full, rel, relBase, imported, importSource));
      } catch {
        // skip
      }
    }
    return docs;
  }

  /** Get: a doc by relative path without `.md`; imported docs are tried after local ones. */
  get(path: string): Doc {
    const resolved = resolveDocPath(this.docsDir(), path);
    const p = resolved.path;
    const folderOf = (x: string) => {
      const d = dirname(x.replaceAll("/", sep));
      return d === "." ? "" : toSlash(d);
    };
    if (existsSync(resolved.abs)) return this.parseFile(resolved.abs, p, folderOf(p), false, "");
    for (const e of readDirSorted(this.importsDir())) {
      if (!e.isDirectory()) continue;
      const importDocs = join(this.importsDir(), e.name, "docs");
      try {
        const candidate = resolveSafe(importDocs, `${p}.md`);
        if (existsSync(candidate)) return this.parseFile(candidate, p, folderOf(p), true, e.name);
      } catch {
        continue;
      }
      try {
        const prefixed = `${e.name}/${p}`;
        const candidate = resolveSafe(importDocs, `${prefixed}.md`);
        if (existsSync(candidate)) {
          return this.parseFile(candidate, prefixed, folderOf(prefixed), true, e.name);
        }
      } catch {
        // next import
      }
    }
    throw new Error(`doc "${p}" not found`);
  }

  create(doc: Doc): void {
    if (!doc || doc.path === "") throw new Error("doc path is required");
    const { path, abs } = resolveDocPath(this.docsDir(), doc.path);
    doc.path = path;
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    this.writeFile(abs, doc);
  }

  update(doc: Doc): void {
    if (!doc || doc.path === "") throw new Error("doc path is required");
    const { path, abs } = resolveDocPath(this.docsDir(), doc.path);
    doc.path = path;
    applyLockedDecisionReviewGate(this.tryGet(path), doc);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    this.writeFile(abs, doc);
  }

  /** Rename: rewrite the doc at its new path and remove the old file. */
  rename(oldPath: string, doc: Doc): void {
    if (goTrimSpace(oldPath) === "" || !doc || goTrimSpace(doc.path) === "") {
      throw new Error("old path and new doc path are required");
    }
    const old = resolveDocPath(this.docsDir(), oldPath);
    const next = resolveDocPath(this.docsDir(), doc.path);
    doc.path = next.path;
    applyLockedDecisionReviewGate(this.tryGet(old.path), doc);
    mkdirSync(dirname(next.abs), { recursive: true, mode: 0o755 });
    this.writeFile(next.abs, doc);
    if (old.abs !== next.abs) rmSync(old.abs, { force: true });
  }

  /** writeExact: rollback primitive; does not backfill a legacy ID. */
  writeExact(doc: Doc): void {
    if (!doc || goTrimSpace(doc.path) === "") throw new Error("doc path is required");
    const { path, abs } = resolveDocPath(this.docsDir(), doc.path);
    doc.path = path;
    atomicWrite(abs, renderDoc(doc));
  }

  renameExact(oldPath: string, doc: Doc): void {
    if (!doc || goTrimSpace(oldPath) === "") throw new Error("old path and new doc are required");
    const old = resolveDocPath(this.docsDir(), oldPath);
    const next = resolveDocPath(this.docsDir(), doc.path);
    doc.path = next.path;
    mkdirSync(dirname(next.abs), { recursive: true, mode: 0o755 });
    atomicWrite(next.abs, renderDoc(doc));
    if (old.path !== next.path) rmSync(old.abs, { force: true });
  }

  writeRaw(path: string, data: string | Uint8Array): void {
    atomicWrite(resolveDocPath(this.docsDir(), path).abs, data);
  }

  renameRaw(oldPath: string, newPath: string, data: string | Uint8Array): void {
    const old = resolveDocPath(this.docsDir(), oldPath);
    const next = resolveDocPath(this.docsDir(), newPath);
    mkdirSync(dirname(next.abs), { recursive: true, mode: 0o755 });
    atomicWrite(next.abs, data);
    if (old.abs !== next.abs) rmSync(old.abs, { force: true });
  }

  delete(path: string): void {
    rmSync(resolveDocPath(this.docsDir(), path).abs);
  }

  /**
   * RewriteDocReferences: rewrite @doc refs across local docs, tasks, and memories. `rewrite` is
   * references.RewriteDocPath (the references package is ported separately).
   */
  async rewriteDocReferences(
    oldPath: string,
    newPath: string,
    rewrite: DocPathRewriter,
    taskStore?: TaskStore,
    memoryStore?: MemoryStore,
  ): Promise<void> {
    for (const doc of this.list()) {
      if (doc.isImported || doc.path === newPath) continue;
      let full: Doc;
      try {
        full = this.get(doc.path);
      } catch {
        continue;
      }
      const rewritten = rewrite(full.content ?? "", oldPath, newPath);
      if (rewritten === (full.content ?? "")) continue;
      full.content = rewritten;
      full.updatedAt = new Date().toISOString();
      this.update(full);
    }
    if (taskStore) {
      for (const task of taskStore.listAll()) {
        let updated = false;
        if (task.spec === oldPath) {
          task.spec = newPath;
          updated = true;
        }
        const d = rewrite(task.description ?? "", oldPath, newPath);
        if (d !== (task.description ?? "")) {
          task.description = d;
          updated = true;
        }
        const p = rewrite(task.implementationPlan ?? "", oldPath, newPath);
        if (p !== (task.implementationPlan ?? "")) {
          task.implementationPlan = p;
          updated = true;
        }
        const n = rewrite(task.implementationNotes ?? "", oldPath, newPath);
        if (n !== (task.implementationNotes ?? "")) {
          task.implementationNotes = n;
          updated = true;
        }
        if (updated) {
          task.updatedAt = new Date().toISOString();
          await taskStore.update(task);
        }
      }
    }
    if (memoryStore) {
      for (const memory of memoryStore.list()) {
        const rewritten = rewrite(memory.content ?? "", oldPath, newPath);
        if (rewritten === (memory.content ?? "")) continue;
        memory.content = rewritten;
        memory.updatedAt = new Date().toISOString();
        await memoryStore.update(memory);
      }
    }
  }

  private tryGet(path: string): Doc | undefined {
    try {
      return this.get(path);
    } catch {
      return undefined;
    }
  }

  private parseFile(
    abs: string,
    rel: string,
    folder: string,
    imported: boolean,
    importSource: string,
  ): Doc {
    let data: string;
    try {
      data = readFileSync(abs, "utf8");
    } catch (e) {
      throw new Error(`parseFile ${abs}: ${(e as Error).message}`);
    }
    const doc = parseDocContent(data, rel, folder, imported, importSource);
    doc.canonicalHash = canonicalDocHash(doc);
    return doc;
  }

  /** writeFile: backfill a missing ID, normalise the body, and write the canonical form. */
  private writeFile(abs: string, doc: Doc): void {
    if (goTrimSpace(doc.id ?? "") === "") doc.id = newDocId();
    doc.content = goTrimSpace(doc.content ?? "");
    atomicWrite(abs, renderDoc(doc));
  }
}

function validateDocStableIds(docs: readonly Doc[]): void {
  const seen = new Map<string, string>();
  for (const doc of docs) {
    if (!doc.id || goTrimSpace(doc.id) === "") continue;
    const prev = seen.get(doc.id);
    if (prev !== undefined && prev !== doc.path) {
      throw new Error(
        `ambiguous Doc stable ID "${doc.id}" at paths "${prev}" and "${doc.path}"; repair duplicate frontmatter id before mutating`,
      );
    }
    seen.set(doc.id, doc.path);
  }
}
