// Port of internal/mcp/handlers/doc.go.
import { docHooks } from "../../cli/commands/doc-hooks.ts";
import type { Doc } from "../../models/doc.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import {
  boolArg,
  ErrPathReq,
  errFailed,
  errNotFound,
  historyPageArgs,
  MUTATION_FULL,
  noProjectError,
  notNil,
  parseMutationReturn,
  stringArg,
  stringSetArg,
  stringSliceArg,
} from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import { notifyDocUpdated, notifyRefresh } from "../notify.ts";
import { CapDelete, effectivePolicy } from "../permissions.ts";
import type { McpState, Project } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";
import { tombstoneRestoreResult } from "./tombstone.ts";

export async function handle(
  state: McpState,
  ctx: { signal?: AbortSignal },
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "create":
      return create(state, req);
    case "get":
      return get(state, req);
    case "update":
      return update(state, req);
    case "delete":
      return del(state, req);
    case "hard_delete":
      return hardDelete(state, ctx, req);
    case "list":
      return list(state, req);
    case "history":
      return history(state, req);
    case "diff":
      return diff(state, req);
    case "restore":
      return restore(state, req);
    default:
      return errorResult(`unknown docs action: ${a.value}`);
  }
}

async function docJson(doc: Doc): Promise<Record<string, unknown>> {
  const { docJSON } = await import("../../cli/commands/doc.ts");
  return docJSON(doc);
}

async function mutationResult(
  doc: Doc,
  mode: string,
  previousPath: string,
): Promise<CallToolResult> {
  if (mode === MUTATION_FULL) return textResult(marshalIndent(await docJson(doc)));
  const out: Record<string, unknown> = { success: true, path: doc.path };
  if (previousPath !== "" && previousPath !== doc.path) out.previousPath = previousPath;
  out.updatedAt = doc.updatedAt;
  return textResult(marshalIndent(out));
}

const runeLen = (s: string): number => [...s].length;

async function list(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  let docs: Doc[];
  try {
    docs = project.storage.docs.list();
  } catch (e) {
    return errFailed("list docs", e);
  }
  const [tag] = stringArg(argsOf(req), "tag");
  const filtered: Doc[] = [];
  for (const d of docs) {
    if (tag !== "" && !(d.tags ?? []).includes(tag)) continue;
    d.content = "";
    filtered.push(d);
  }
  if (filtered.length === 0) {
    return textResult(
      marshalIndent(
        goMap({
          results: [],
          _projectRoot: project.store.root,
          _hint:
            'No docs found. Verify the active project is correct via project({ action: "current" }).',
        }),
      ),
    );
  }
  return textResult(marshalIndent(await Promise.all(filtered.map(docJson))));
}

/** extractHeadings: every line starting with #, trimmed; nil (null) when there are none. */
function extractHeadings(content: string): string[] | null {
  const out: string[] = [];
  for (const line of content.split("\n")) if (line.startsWith("#")) out.push(goTrimSpace(line));
  return out.length === 0 ? null : out;
}

function headingLevel(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === "#") n++;
    else break;
  }
  return n;
}

/** fmt.Sscanf(s, "%d", &n) == 1: a leading (optionally signed) integer after blanks. */
function sscanInt(s: string): number | undefined {
  const m = /^[ \t\r\n]*([+-]?\d+)/.exec(s);
  return m ? Number(m[1]) : undefined;
}

const trimLeftSet = (s: string, set: string): string => {
  let i = 0;
  while (i < s.length && set.includes(s[i] as string)) i++;
  return s.slice(i);
};

function extractSectionFromLine(lines: string[], startLine: number, level: number): string {
  const result = [lines[startLine] as string];
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith("#") && headingLevel(line) <= level) break;
    result.push(line);
  }
  return goTrimSpace(result.join("\n"));
}

function extractSection(content: string, section: string): string {
  const lines = content.split("\n");
  const sectionNum = sscanInt(section);
  if (sectionNum !== undefined) {
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.startsWith("#")) {
        count++;
        if (count === sectionNum) return extractSectionFromLine(lines, i, headingLevel(line));
      }
    }
    return "";
  }
  const searchTitle = trimLeftSet(section, "# ");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith("#")) continue;
    const lineTitle = trimLeftSet(line, "# ");
    if (goTrimSpace(lineTitle).toLowerCase() === goTrimSpace(searchTitle).toLowerCase()) {
      return extractSectionFromLine(lines, i, headingLevel(line));
    }
  }
  return "";
}

function replaceSection(content: string, target: string, newContent: string): string {
  const lines = content.split("\n");
  let startLine = -1;
  let level = 0;
  const num = sscanInt(target);
  if (num !== undefined) {
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.startsWith("#")) {
        count++;
        if (count === num) {
          startLine = i;
          level = headingLevel(line);
          break;
        }
      }
    }
  } else {
    const searchTitle = trimLeftSet(target, "# ");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.startsWith("#")) continue;
      if (
        goTrimSpace(trimLeftSet(line, "# ")).toLowerCase() ===
        goTrimSpace(searchTitle).toLowerCase()
      ) {
        startLine = i;
        level = headingLevel(line);
        break;
      }
    }
  }
  if (startLine === -1) return content;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith("#") && headingLevel(line) <= level) {
      endLine = i;
      break;
    }
  }
  const replacement = newContent.split("\n");
  const section = lines.slice(startLine, endLine);
  for (let i = section.length - 1; i >= 0 && goTrimSpace(section[i] as string) === ""; i--) {
    if (
      replacement.length === 0 ||
      goTrimSpace(replacement[replacement.length - 1] as string) !== ""
    ) {
      replacement.push("");
    }
  }
  return [...lines.slice(0, startLine), ...replacement, ...lines.slice(endLine)].join("\n");
}

/** strconv.Atoi: optional sign and digits only. */
const atoi = (s: string): number | undefined => (/^[+-]?\d+$/.test(s) ? Number(s) : undefined);

function extractLines(content: string, param: string): [string, string, string | undefined] {
  const all = content.split("\n");
  const total = all.length;
  const dash = param.indexOf("-");
  if (dash >= 0) {
    const start = atoi(param.slice(0, dash));
    let end = atoi(param.slice(dash + 1));
    if (start !== undefined && end !== undefined && start >= 1 && end >= start) {
      if (start > total) {
        return ["", "", `line ${start} exceeds document length (${total} lines)`];
      }
      if (end > total) end = total;
      return [all.slice(start - 1, end).join("\n"), `${start}-${end}`, undefined];
    }
  }
  const line = atoi(param);
  if (line === undefined) {
    return ["", "", `invalid line parameter: ${goQuoteStr(param)} (use '42' or '10-20')`];
  }
  if (line < 1 || line > total) {
    return ["", "", `line ${line} out of range (document has ${total} lines)`];
  }
  return [all[line - 1] as string, String(line), undefined];
}

import { goQuote } from "../../cli/core/gofmt.ts";

const goQuoteStr = goQuote;

async function get(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const p = requireString(req, "path");
  if (!p.ok) return errorResult(ErrPathReq);
  let doc: Doc;
  try {
    doc = project.storage.docs.get(p.value);
  } catch (e) {
    return errNotFound("Doc", e);
  }
  const args = argsOf(req);
  const smart = boolArg(args, "smart");
  const info = boolArg(args, "info");
  const tocOnly = boolArg(args, "toc");
  const includeHistory = boolArg(args, "includeHistory");
  const [section, hasSection] = stringArg(args, "section");
  const [lineParam, hasLine] = stringArg(args, "line");
  const content = doc.content ?? "";
  const contentLen = runeLen(content);
  const approxTokens = Math.trunc(contentLen / 4);

  if (info) {
    return textResult(
      marshalIndent(
        goMap({
          id: doc.id ?? "",
          path: doc.path,
          title: doc.title,
          description: doc.description ?? "",
          tags: doc.tags ?? null,
          size: contentLen,
          tokens: approxTokens,
          headings: extractHeadings(content),
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        }),
      ),
    );
  }
  if (tocOnly) {
    return textResult(
      marshalIndent(
        goMap({ path: doc.path, title: doc.title, headings: extractHeadings(content) }),
      ),
    );
  }
  if (hasSection && section !== "") {
    return textResult(
      marshalIndent(
        goMap({
          path: doc.path,
          title: doc.title,
          section,
          content: extractSection(content, section),
        }),
      ),
    );
  }
  if (hasLine && lineParam !== "") {
    const [text, label, err] = extractLines(content, lineParam);
    if (err) return errorResult(err);
    return textResult(
      marshalIndent(goMap({ path: doc.path, title: doc.title, lines: label, content: text })),
    );
  }
  if (smart) {
    if (approxTokens <= 2000) {
      if (includeHistory) return docWithHistory(project, doc);
      return textResult(marshalIndent(await docJson(doc)));
    }
    return textResult(
      marshalIndent(
        goMap({
          id: doc.id ?? "",
          canonicalHash: doc.canonicalHash ?? "",
          path: doc.path,
          title: doc.title,
          description: doc.description ?? "",
          tags: doc.tags ?? null,
          size: contentLen,
          tokens: approxTokens,
          headings: extractHeadings(content),
          note: "Document is large. Use 'section' parameter to read a specific section, or 'toc: true' to see the table of contents.",
        }),
      ),
    );
  }
  if (includeHistory) return docWithHistory(project, doc);
  return textResult(marshalIndent(await docJson(doc)));
}

async function docHistoryWire(project: Project, path: string): Promise<unknown> {
  const { docHistoryJSON } = await import("../../cli/commands/doc-history.ts");
  return docHistoryJSON(await project.storage.versions.getDocHistory(path));
}

async function docWithHistory(project: Project, doc: Doc): Promise<CallToolResult> {
  let h: unknown;
  try {
    h = await docHistoryWire(project, doc.path);
  } catch (e) {
    return errFailed("get doc history", e);
  }
  return textResult(marshalIndent(goMap({ doc: await docJson(doc), history: h })));
}

const slugify = (title: string): string => {
  let b = "";
  let prevHyphen = false;
  for (const r of title.toLowerCase()) {
    if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9")) {
      b += r;
      prevHyphen = false;
    } else if (r === "-" || r === " " || r === "_") {
      if (!prevHyphen) {
        b += "-";
        prevHyphen = true;
      }
    }
  }
  return b.replace(/^-+|-+$/g, "");
};

async function create(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const t = requireString(req, "title");
  if (!t.ok) return errorResult(t.error);
  const args = argsOf(req);
  const rm = parseMutationReturn(args);
  if (rm.error) return errorResult(rm.error);
  const slug = slugify(t.value);
  const [folder] = stringArg(args, "folder");
  const docPath = folder !== "" ? `${folder}/${slug}` : slug;
  const now = new Date().toISOString();
  const doc: Doc = { path: docPath, title: t.value, tags: [], createdAt: now, updatedAt: now };
  const [description, dok] = stringArg(args, "description");
  if (dok && description !== "") doc.description = description;
  const [content, cok] = stringArg(args, "content");
  if (cok && content !== "") doc.content = content;
  const [tags, tok] = stringSliceArg(args, "tags");
  if (tok) doc.tags = tags;
  try {
    const { mutateDocWithHistory } = await import("../../storage/history/index.ts");
    await mutateDocWithHistory(project.storage.ctx, null, doc, { actor: "mcp", source: "mcp" });
  } catch (e) {
    return errFailed("create doc", e);
  }
  docHooks.indexDoc(project.storage, doc.path);
  notifyDocUpdated(project.store, doc.path);
  return mutationResult(doc, rm.mode, "");
}

async function update(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const p = requireString(req, "path");
  if (!p.ok) return errorResult(ErrPathReq);
  const { storage } = project;
  let doc: Doc;
  try {
    doc = storage.docs.get(p.value);
  } catch (e) {
    return errNotFound("Doc", e);
  }
  const oldDoc: Doc = { ...doc };
  const args = argsOf(req);
  const rm = parseMutationReturn(args);
  if (rm.error) return errorResult(rm.error);
  const clear = stringSetArg(args, "clear");
  const oldPath = doc.path;
  const [expectedHash] = stringArg(args, "expectedHash");

  const [title, tok] = stringArg(args, "title");
  if (clear.has("title")) doc.title = "";
  else if (tok && title !== "") doc.title = title;
  const [description, dok] = stringArg(args, "description");
  if (clear.has("description")) delete doc.description;
  else if (dok && description !== "") doc.description = description;
  if (Object.hasOwn(args, "tags")) {
    const [tags, ok] = stringSliceArg(args, "tags");
    doc.tags = ok ? tags : [];
  }
  const [newPath, npok] = stringArg(args, "newPath");
  if (npok && goTrimSpace(newPath) !== "") {
    const noMd = newPath.endsWith(".md") ? newPath.slice(0, -3) : newPath;
    doc.path = noMd.replace(/^\/+|\/+$/g, "");
  }
  const [sectionTarget, hasSection] = stringArg(args, "section");
  const [newContent, hasContent] = stringArg(args, "content");
  const [appendContent, hasAppend] = stringArg(args, "appendContent");
  const cur = doc.content ?? "";
  let next = cur;
  if (clear.has("content")) next = "";
  else if (hasSection && sectionTarget !== "" && hasContent)
    next = replaceSection(cur, sectionTarget, newContent);
  else if (hasContent && newContent !== "") next = newContent;
  if (hasAppend && appendContent !== "") {
    if (next === "") next = appendContent;
    else {
      if (!next.endsWith("\n")) next += "\n";
      next += appendContent;
    }
  }
  if (next === "") delete doc.content;
  else doc.content = next;
  doc.updatedAt = new Date().toISOString();

  try {
    const { mutateDocWithHistory } = await import("../../storage/history/index.ts");
    await mutateDocWithHistory(storage.ctx, oldDoc, doc, {
      section: sectionTarget,
      actor: "mcp",
      source: "mcp",
      expectedHash,
    });
  } catch (e) {
    return errFailed("update doc", e);
  }
  if (oldPath !== doc.path) docHooks.renameDoc(storage, doc.id ?? "", oldPath, doc.path);
  else docHooks.indexDoc(storage, doc.path);
  if (oldPath !== doc.path) notifyRefresh(project.store);
  else notifyDocUpdated(project.store, doc.path);
  return mutationResult(doc, rm.mode, oldPath);
}

function docRevisionArg(args: Record<string, unknown>): string {
  for (const k of ["revision", "revisionId"]) {
    const [v, ok] = stringArg(args, k);
    if (ok && goTrimSpace(v) !== "") return goTrimSpace(v);
  }
  return "";
}

async function history(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const p = requireString(req, "path");
  if (!p.ok) return errorResult(ErrPathReq);
  const args = argsOf(req);
  const { versions } = project.storage;
  const { docVersionJSON, docHistoryPageJSON } = await import("../../cli/commands/doc-history.ts");
  const revision = docRevisionArg(args);
  if (revision !== "") {
    try {
      return textResult(
        marshalIndent(docVersionJSON(await versions.getDocRevisionDetail(p.value, revision))),
      );
    } catch (e) {
      return errFailed("get doc revision", e);
    }
  }
  if (boolArg(args, "metadata") || notNil(args, "offset") || notNil(args, "limit")) {
    const [offset, limit, err] = historyPageArgs(args);
    if (err) return errorResult(err);
    try {
      return textResult(
        marshalIndent(
          docHistoryPageJSON(await versions.listDocHistoryMetadata(p.value, offset, limit)),
        ),
      );
    } catch (e) {
      return errFailed("list doc history metadata", e);
    }
  }
  try {
    return textResult(marshalIndent(await docHistoryWire(project, p.value)));
  } catch (e) {
    return errFailed("get doc history", e);
  }
}

async function diff(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const p = requireString(req, "path");
  if (!p.ok) return errorResult(ErrPathReq);
  const { docVersionJSON, docHistoryJSON } = await import("../../cli/commands/doc-history.ts");
  let d: Awaited<ReturnType<Project["storage"]["versions"]["getDocRevisionDiff"]>>;
  try {
    d = await project.storage.versions.getDocRevisionDiff(p.value, docRevisionArg(argsOf(req)));
  } catch (e) {
    return errFailed("get doc revision diff", e);
  }
  const shaped = docVersionJSON({
    ...d.version,
    changes: d.changes as never,
    changedScopes: d.changedScopes as never,
  });
  const gaps = d.retentionGaps
    ? (docHistoryJSON({
        docPath: "",
        currentVersion: 0,
        versions: [],
        retentionGaps: d.retentionGaps,
      } as never).retentionGaps as unknown)
    : undefined;
  const out: Record<string, unknown> = {};
  if (d.docId) out.docId = d.docId;
  out.docPath = d.docPath;
  if (d.currentPath) out.currentPath = d.currentPath;
  out.revisionId = d.revisionId;
  if (d.previousRevisionId) out.previousRevisionId = d.previousRevisionId;
  out.version = docVersionJSON(d.version);
  out.checkpoint = d.checkpoint;
  out.changes = shaped.changes ?? null;
  if (shaped.changedScopes !== undefined) out.changedScopes = shaped.changedScopes;
  if (gaps !== undefined) out.retentionGaps = gaps;
  return textResult(marshalIndent(out));
}

async function restore(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const p = requireString(req, "path");
  if (!p.ok) return errorResult(ErrPathReq);
  const args = argsOf(req);
  const revision = docRevisionArg(args);
  if (revision === "") return tombstoneRestoreResult(project, "doc", p.value, true);
  const [section] = stringArg(args, "section");
  const [modeRaw] = stringArg(args, "mode");
  const mode = goTrimSpace(modeRaw).toLowerCase();
  const [expectedHash] = stringArg(args, "expectedHash");
  const opts = { actor: "mcp", source: "mcp", expectedHash };
  const { restoreDoc, restoreDocSection } = await import("../../storage/history/index.ts");
  let restored: Doc;
  try {
    if (section !== "" || mode === "section") {
      restored = await restoreDocSection(project.storage.ctx, p.value, revision, section, opts);
    } else if (mode === "" || mode === "document" || mode === "whole_doc" || mode === "whole-doc") {
      restored = await restoreDoc(project.storage.ctx, p.value, revision, opts);
    } else {
      return errorResult(`unknown restore mode: ${mode}`);
    }
  } catch (e) {
    return errFailed("restore doc", e);
  }
  docHooks.indexDoc(project.storage, restored.path);
  notifyDocUpdated(project.store, restored.path);
  let h: unknown = null;
  try {
    h = await docHistoryWire(project, restored.path);
  } catch {
    h = null;
  }
  return textResult(
    marshalIndent(goMap({ restored: true, doc: await docJson(restored), history: h })),
  );
}

async function del(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [path, ok] = stringArg(args, "path");
  if (!ok || path === "") return errorResult(ErrPathReq);
  let dryRun = true;
  if (Object.hasOwn(args, "dryRun") && typeof args.dryRun === "boolean") dryRun = args.dryRun;
  let doc: Doc;
  try {
    doc = project.storage.docs.get(path);
  } catch (e) {
    return errNotFound("Doc", e);
  }
  let [expectedHash] = stringArg(args, "expectedHash");
  if (goTrimSpace(expectedHash) === "") expectedHash = doc.canonicalHash ?? "";
  if (dryRun) {
    return textResult(
      marshalIndent(
        goMap({
          dryRun: true,
          message: `Would delete doc: ${doc.path} (${doc.title})`,
          doc: goMap({ path: doc.path, title: doc.title, description: doc.description ?? "" }),
        }),
      ),
    );
  }
  try {
    const { deleteDocWithExpectedHash } = await import("../../storage/history/index.ts");
    await deleteDocWithExpectedHash(project.storage.ctx, path, {
      expectedHash,
      actor: "mcp",
      source: "mcp",
    });
  } catch (e) {
    return errorResult(`Failed to delete doc: ${(e as Error).message}`);
  }
  docHooks.removeDocID(project.storage, doc.id ?? "", doc.path);
  notifyRefresh(project.store);
  return textResult(
    marshalIndent(goMap({ deleted: true, message: `Deleted doc: ${doc.path} (${doc.title})` })),
  );
}

async function hardDelete(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [path, ok] = stringArg(args, "path");
  if (!ok || path === "") return errorResult(ErrPathReq);
  const confirmed = args.confirmed === true;
  const [reason] = stringArg(args, "reason");
  if (!confirmed) return errorResult("doc hard_delete requires confirmed=true");
  if (goTrimSpace(reason) === "") return errorResult("doc hard_delete requires a non-empty reason");
  let policyCfg: ReturnType<Project["storage"]["config"]["load"]>["settings"]["permissions"];
  try {
    policyCfg = project.storage.config.load().settings.permissions;
  } catch {
    policyCfg = undefined;
  }
  const policy = effectivePolicy(policyCfg);
  if (!(policy.allowed.has(CapDelete) && !policy.denied.has(CapDelete))) {
    return errorResult("doc hard_delete requires the project delete capability");
  }
  let doc: Doc;
  try {
    doc = project.storage.docs.get(path);
  } catch (e) {
    return errNotFound("Doc", e);
  }
  let [expectedHash] = stringArg(args, "expectedHash");
  if (goTrimSpace(expectedHash) === "") expectedHash = doc.canonicalHash ?? "";
  if (expectedHash !== (doc.canonicalHash ?? "")) {
    return errorResult("doc hard_delete expected hash conflict");
  }
  const purge = docHooks.hardDelete;
  if (!purge)
    return errFailed("doc hard_delete", new Error("the lifecycle reconciler is not available"));
  const base = doc.path.startsWith("docs/") ? doc.path.slice("docs/".length) : doc.path;
  const canonicalPath = `docs/${base.endsWith(".md") ? base.slice(0, -3) : base}.md`;
  try {
    await purge({
      storage: project.storage,
      docID: doc.id ?? "",
      docPath: doc.path,
      canonicalPath,
      reason,
      expectedHash,
      actor: "mcp",
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "DocReconcileError") {
      return errFailed(
        "doc hard_delete reconcile",
        new Error(err.message.replace(/^reconcile: /, "")),
      );
    }
    return errFailed("doc hard_delete", err);
  }
  docHooks.removeDocID(project.storage, doc.id ?? "", doc.path);
  notifyRefresh(project.store);
  return textResult(marshalIndent(goMap({ hardDeleted: true, path: doc.path })));
}
