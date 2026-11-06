// Port of internal/mcp/handlers/code.go and code_runtime.go: code intelligence over the LSP
// manager (or the project LSP daemon) plus the structural edit actions.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import {
  buildCodeSummaries,
  type CodeBM25Result,
  CodeBM25Scorer,
  type CodeSummary,
  codeSymbolKindString,
} from "../../lsp/code-search.ts";
import { errorAs } from "../../lsp/errors.ts";
import { findSymbolPosition, nameAt, snippet } from "../../lsp/queries.ts";
import { RuntimeError } from "../../lsp/runtime-error.ts";
import {
  allChanges,
  type Diagnostic,
  type DocumentSymbol,
  type Location,
  type Range,
  type Session,
  type TextEdit,
} from "../../lsp/types.ts";
import { pathFromFileURI } from "../../lsp/uri.ts";
import { evalSymlinks, resolveProject, resolveProjectReal } from "../../storage/core/safe-path.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { boolArg, intArg, stringArg } from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import type { McpState, Project } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

type Ctx = AbortSignal | undefined;

/** CodeRuntime: the code-intelligence boundary (manager-backed or daemon-backed). */
interface CodeRuntime {
  withSession(ctx: Ctx, path: string, fn: (s: Session) => Promise<void>): Promise<void>;
  describeRuntimeError(path: string, err: unknown): RuntimeError | undefined;
}

async function getCodeRuntime(state: McpState, ctx: Ctx): Promise<CodeRuntime | undefined> {
  const project = state.getProject();
  if (!project) return undefined;
  const daemon = await import("../../lspdaemon/lifecycle.ts");
  if (daemon.disabledByEnv()) {
    state.warnDaemonDisabledOnce(daemon.disabledWarning());
    const manager = await state.getLspManager();
    if (!manager) return undefined;
    return {
      withSession: (c, p, fn) => manager.withSession(c, p, fn),
      describeRuntimeError: (p, e) => manager.describeRuntimeError(p, e),
    };
  }
  const { newRuntime } = await import("../../lspdaemon/client.ts");
  const rt = await newRuntime(ctx, project.store.projectRoot);
  return rt as unknown as CodeRuntime;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function runtimePayloadResult(err: RuntimeError, action: string): CallToolResult {
  const p = err.payload();
  if (action !== "") p.action = action;
  return errorResult(marshalIndent(goMap(p)));
}

/** codeRuntimeErrorResult: a structured runtime error when there is one, else the plain text. */
function codeRuntimeErrorResult(
  runtime: CodeRuntime | undefined,
  path: string,
  action: string,
  err: unknown,
): CallToolResult {
  const r = codeRuntimeErr(runtime, path, action, err);
  return r ?? errorResult(errMessage(err));
}

function codeRuntimeErr(
  runtime: CodeRuntime | undefined,
  path: string,
  action: string,
  err: unknown,
): CallToolResult | undefined {
  const described = runtime?.describeRuntimeError(path, err) ?? errorAs(err, RuntimeError);
  return described ? runtimePayloadResult(described, action) : undefined;
}

const projectRoot = (p: Project): string => p.store.projectRoot;

function relPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel !== "" && !rel.startsWith("..") && !rel.startsWith(`${sep}`))
    return rel.split(sep).join("/");
  if (rel === "") return ".";
  return path.split(sep).join("/");
}

const lspSeverity = (s: number | undefined): string =>
  ({ 1: "error", 2: "warning", 3: "info", 4: "hint" })[s ?? 0] ?? "error";

export async function handle(
  state: McpState,
  ctx: { signal?: AbortSignal },
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  const c = ctx.signal;
  switch (a.value) {
    case "symbols":
      return symbols(state, c, req);
    case "search":
      return errorResult(
        "Action 'search' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.",
      );
    case "deps":
      return errorResult(
        "Action 'deps' has been removed. Use LSP actions: symbols, definition, references, implementations, diagnostics.",
      );
    case "graph":
      return errorResult("Action 'graph' has been removed.");
    case "definition":
      return definition(state, c, req);
    case "references":
      return references(state, c, req);
    case "implementations":
      return implementations(state, c, req);
    case "diagnostics":
      return diagnostics(state, c, req);
    case "rename":
      return rename(state, c, req);
    case "replace":
      return replace(state, req);
    case "replace_body":
      return replaceBody(state, c, req);
    case "insert":
      return insert(state, c, req);
    case "delete":
      return del(state, c, req);
    case "find":
      return find(state, c, req);
    default:
      return errorResult(`unsupported action: ${a.value}`);
  }
}

// --- request preparation ----------------------------------------------------------------------

type PathReq = { project: Project; runtime: CodeRuntime; absPath: string } | { error: Error };

/** lspPathRequest */
async function pathRequest(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<PathReq> {
  const project = state.getProject();
  if (!project) return { error: new Error("no project loaded") };
  const p = requireString(req, "path");
  if (!p.ok || goTrimSpace(p.value) === "") return { error: new Error("path is required") };
  let absPath: string;
  try {
    absPath = resolveProject(projectRoot(project), p.value);
  } catch (e) {
    return { error: e as Error };
  }
  const runtime = await getCodeRuntime(state, ctx);
  if (!runtime) return { error: new Error("LSP not available for this project") };
  return { project, runtime, absPath };
}

async function symbolRequest(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<
  | {
      project: Project;
      runtime: CodeRuntime;
      absPath: string;
      query: string;
      line: number;
      col: number;
    }
  | CallToolResult
> {
  const pr = await pathRequest(state, ctx, req);
  if ("error" in pr) return errorResult(pr.error.message);
  const q = requireString(req, "query");
  if (!q.ok || goTrimSpace(q.value) === "") return errorResult("query is required");
  const query = goTrimSpace(q.value);
  let pos: [number, number];
  try {
    pos = findSymbolPosition(pr.absPath, query);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return { ...pr, query, line: pos[0], col: pos[1] };
}

const isResult = (v: object): v is CallToolResult => "text" in v && "isError" in v;

function locationResult(root: string, loc: Location): Record<string, unknown> {
  const path = pathFromFileURI(loc.uri);
  return goMap({
    file: relPath(root, path),
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
  });
}

// --- navigation -------------------------------------------------------------------------------

async function definition(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const sr = await symbolRequest(state, ctx, req);
  if (isResult(sr)) return sr;
  let loc: Location | undefined;
  try {
    await sr.runtime.withSession(ctx, sr.absPath, async (s) => {
      loc = await s.definition(ctx, sr.absPath, sr.line, sr.col);
    });
  } catch (e) {
    return codeRuntimeErrorResult(sr.runtime, sr.absPath, "definition", e);
  }
  return textResult(marshalIndent(locationResult(projectRoot(sr.project), loc as Location)));
}

async function references(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const sr = await symbolRequest(state, ctx, req);
  if (isResult(sr)) return sr;
  let locs: Location[] = [];
  try {
    await sr.runtime.withSession(ctx, sr.absPath, async (s) => {
      locs = await s.references(ctx, sr.absPath, sr.line, sr.col);
    });
  } catch (e) {
    return codeRuntimeErrorResult(sr.runtime, sr.absPath, "references", e);
  }
  const root = projectRoot(sr.project);
  const items = locs.map((loc) => {
    const item = locationResult(root, loc);
    const file = item.file as string;
    item.snippet = snippet(join(root, file), loc.range.start.line);
    return goMap(item);
  });
  return textResult(marshalIndent(items));
}

async function implementations(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const sr = await symbolRequest(state, ctx, req);
  if (isResult(sr)) return sr;
  let locs: Location[] = [];
  try {
    await sr.runtime.withSession(ctx, sr.absPath, async (s) => {
      locs = await s.implementations(ctx, sr.absPath, sr.line, sr.col);
    });
  } catch (e) {
    return codeRuntimeErrorResult(sr.runtime, sr.absPath, "implementations", e);
  }
  const root = projectRoot(sr.project);
  const items = locs.map((loc) => {
    const item = locationResult(root, loc);
    item.name = nameAt(
      join(root, item.file as string),
      loc.range.start.line,
      loc.range.start.character,
    );
    return goMap(item);
  });
  return textResult(marshalIndent(items));
}

async function diagnostics(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const pr = await pathRequest(state, ctx, req);
  if ("error" in pr) return errorResult(pr.error.message);
  const [severityFilter] = stringArg(argsOf(req), "severity");
  let diags: Diagnostic[] = [];
  try {
    await pr.runtime.withSession(ctx, pr.absPath, async (s) => {
      diags = await s.diagnostics(ctx, pr.absPath);
    });
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "diagnostics", e);
  }
  const items: Record<string, unknown>[] = [];
  for (const d of diags) {
    const severity = lspSeverity(d.severity);
    if (severityFilter !== "" && severityFilter !== severity) continue;
    items.push(
      goMap({
        file: relPath(projectRoot(pr.project), pr.absPath),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity,
        message: d.message,
      }),
    );
  }
  return textResult(marshalIndent(items));
}

// --- symbols ----------------------------------------------------------------------------------

/** DocumentSymbol as Go marshals it: declared field order, omitempty. */
function symbolJson(s: DocumentSymbol): Record<string, unknown> {
  const r = (x: Range) => ({
    start: { line: x.start.line, character: x.start.character },
    end: { line: x.end.line, character: x.end.character },
  });
  const out: Record<string, unknown> = { name: s.name };
  if (s.detail) out.detail = s.detail;
  out.kind = s.kind;
  out.range = r(s.range);
  out.selectionRange = r(s.selectionRange);
  if (s.children && s.children.length > 0) out.children = s.children.map(symbolJson);
  return out;
}

function groupSymbolNames(
  grouped: Map<string, string[]>,
  parent: string,
  sym: DocumentSymbol,
): void {
  const name = parent !== "" ? `${parent}.${sym.name}` : sym.name;
  const kind = codeSymbolKindString(sym.kind);
  const list = grouped.get(kind) ?? [];
  list.push(name);
  grouped.set(kind, list);
  for (const child of sym.children ?? []) groupSymbolNames(grouped, name, child);
}

function nestedSymbols(symbols: DocumentSymbol[], depth: number): Record<string, unknown>[] {
  return symbols.map((sym) => {
    const item: Record<string, unknown> = {
      name: sym.name,
      kind: codeSymbolKindString(sym.kind),
      line: sym.range.start.line + 1,
    };
    if (depth > 0 && (sym.children ?? []).length > 0) {
      item.children = nestedSymbols(sym.children ?? [], depth - 1);
    }
    return goMap(item);
  });
}

function sourceForRange(path: string, rng: Range): string {
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = data.split("\n");
  if (rng.start.line < 0 || rng.start.line >= lines.length) return "";
  let end = rng.end.line;
  if (end >= lines.length) end = lines.length - 1;
  return lines.slice(rng.start.line, end + 1).join("\n");
}

function detailedSymbol(
  root: string,
  absPath: string,
  sym: DocumentSymbol,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    name: sym.name,
    kind: codeSymbolKindString(sym.kind),
    file: relPath(root, absPath),
    body_location: goMap({
      start_line: sym.range.start.line + 1,
      end_line: sym.range.end.line + 1,
    }),
    body: sourceForRange(absPath, sym.range),
  };
  if ((sym.children ?? []).length > 0) {
    item.children = (sym.children ?? []).map((c) => detailedSymbol(root, absPath, c));
  }
  return goMap(item);
}

async function symbols(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<CallToolResult> {
  const pr = await pathRequest(state, ctx, req);
  if ("error" in pr) {
    const re = errorAs(pr.error, RuntimeError);
    return re ? runtimePayloadResult(re, "") : errorResult(pr.error.message);
  }
  const args = argsOf(req);
  const [depth] = intArg(args, "depth");
  const includeBody = boolArg(args, "include_body");
  const verbose = boolArg(args, "verbose");
  const [kindFilter] = stringArg(args, "kind");
  let syms: DocumentSymbol[] = [];
  try {
    await pr.runtime.withSession(ctx, pr.absPath, async (s) => {
      syms = await s.documentSymbols(ctx, pr.absPath);
    });
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "symbols", e);
  }
  if (kindFilter !== "") {
    syms = syms.filter(
      (s) => codeSymbolKindString(s.kind).toLowerCase() === kindFilter.toLowerCase(),
    );
  }
  if (verbose) return textResult(marshalIndent(syms.map(symbolJson)));
  let resp: unknown;
  const root = projectRoot(pr.project);
  if (includeBody) {
    resp = syms.map((s) => detailedSymbol(root, pr.absPath, s));
  } else if (depth > 0) {
    resp = nestedSymbols(syms, depth);
  } else {
    const grouped = new Map<string, string[]>();
    for (const s of syms) groupSymbolNames(grouped, "", s);
    const o: Record<string, unknown> = {};
    for (const [k, v] of grouped) o[k] = v;
    resp = goMap(o);
  }
  return textResult(marshalIndent(resp));
}

// --- mutation guards --------------------------------------------------------------------------

/** ensureCodeMutationPath: code edits never touch .knowns or .git. */
function ensureCodeMutationPath(root: string, absPath: string): void {
  let realRoot: string;
  try {
    realRoot = evalSymlinks(root);
  } catch (e) {
    throw new Error(`resolve project root: ${errMessage(e)}`);
  }
  const realPath = resolveProjectReal(root, absPath);
  const rel = relative(realRoot, realPath);
  const top = (rel.split(sep).join("/").split("/")[0] ?? "").toLowerCase();
  if (top === ".knowns" || top === ".git") {
    throw new Error(
      `code mutations cannot modify managed path "${rel.split(sep).join("/").split("/")[0]}"`,
    );
  }
  for (const managedName of [".knowns", ".git"]) {
    const managedPath = join(realRoot, managedName);
    let managedInfo: ReturnType<typeof statSync>;
    try {
      managedInfo = statSync(managedPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`inspect managed path "${managedName}": ${errMessage(e)}`);
    }
    for (let current = realPath; ; current = dirname(current)) {
      try {
        const info = statSync(current);
        if (info.ino === managedInfo.ino && info.dev === managedInfo.dev) {
          throw new Error(`code mutations cannot modify managed path "${managedName}"`);
        }
      } catch (e) {
        if ((e as Error).message.startsWith("code mutations")) throw e;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`inspect code mutation path: ${errMessage(e)}`);
        }
      }
      if (current === realRoot) break;
      const parent = dirname(current);
      if (parent === current) break;
    }
  }
}

// --- edits ------------------------------------------------------------------------------------

function utf16OffsetToByteOffset(s: string, target: number): number {
  let units = 0;
  let byteIdx = 0;
  for (const ch of s) {
    if (units === target) return byteIdx;
    const cp = ch.codePointAt(0) as number;
    units += cp > 0xffff ? 2 : 1;
    byteIdx += Buffer.byteLength(ch);
    if (units > target) throw new Error(`character ${target} splits utf16 surrogate`);
  }
  if (units === target) return byteIdx;
  throw new Error(`character ${target} out of range`);
}

function splitAfterNewline(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Byte offset of an LSP position in content (UTF-8 bytes, like Go's string indexing). */
function offsetForPosition(content: Buffer, pos: { line: number; character: number }): number {
  if (pos.line < 0 || pos.character < 0) throw new Error("invalid position");
  const lines = splitAfterNewline(content.toString("utf8"));
  if (pos.line >= lines.length) {
    if (pos.line === lines.length && pos.character === 0) return content.length;
    throw new Error(`line ${pos.line} out of range`);
  }
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += Buffer.byteLength(lines[i] as string);
  const line = (lines[pos.line] as string).replace(/\n$/, "");
  return offset + utf16OffsetToByteOffset(line, pos.character);
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const x = a.range.start;
    const y = b.range.start;
    if (x.line !== y.line) return y.line - x.line;
    return y.character - x.character;
  });
  let out = Buffer.from(content, "utf8");
  for (const edit of sorted) {
    const start = offsetForPosition(out, edit.range.start);
    const end = offsetForPosition(out, edit.range.end);
    if (start > end) throw new Error("invalid edit range");
    out = Buffer.concat([
      out.subarray(0, start),
      Buffer.from(edit.newText, "utf8"),
      out.subarray(end),
    ]);
  }
  return out.toString("utf8");
}

function applyWorkspaceEdit(
  root: string,
  changes: Record<string, TextEdit[]>,
): { files: string[]; total: number } {
  const originals = new Map<string, Buffer>();
  const updated = new Map<string, string>();
  const files: string[] = [];
  let total = 0;
  for (const [uri, edits] of Object.entries(changes)) {
    if (edits.length === 0) continue;
    const path = resolveProject(root, pathFromFileURI(uri));
    ensureCodeMutationPath(root, path);
    const data = readFileSync(path);
    originals.set(path, data);
    updated.set(path, applyTextEdits(data.toString("utf8"), edits));
    files.push(path);
    total += edits.length;
  }
  for (const path of files) {
    try {
      writeFileSync(path, updated.get(path) as string);
    } catch (e) {
      for (const [p, d] of originals) {
        try {
          writeFileSync(p, d);
        } catch {
          // best effort rollback
        }
      }
      throw e;
    }
  }
  files.sort();
  return { files, total };
}

async function rename(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<CallToolResult> {
  const pr = await pathRequest(state, ctx, req);
  if ("error" in pr) return errorResult(pr.error.message);
  const root = projectRoot(pr.project);
  try {
    ensureCodeMutationPath(root, pr.absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  const args = argsOf(req);
  const [line, lok] = intArg(args, "line");
  if (!lok) return errorResult("line is required");
  const [character, cok] = intArg(args, "character");
  if (!cok) return errorResult("character is required");
  const [newName, nok] = stringArg(args, "newName");
  if (!nok || goTrimSpace(newName) === "") return errorResult("newName is required");
  let edit: Awaited<ReturnType<Session["rename"]>> | undefined;
  try {
    await pr.runtime.withSession(ctx, pr.absPath, async (s) => {
      edit = await s.rename(ctx, pr.absPath, line, character, newName);
    });
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "rename", e);
  }
  const changes = edit ? allChanges(edit) : {};
  let applied: { files: string[]; total: number };
  try {
    applied = applyWorkspaceEdit(root, changes);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        files_changed: applied.files.map((f) => relPath(root, f)),
        total_edits: applied.total,
      }),
    ),
  );
}

/** Go regexp.ReplaceAllString template expansion: $1, ${1}, $name, ${name}, $$. */
function goExpand(template: string, m: RegExpMatchArray): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i] as string;
    if (c !== "$" || i + 1 >= template.length) {
      out += c;
      continue;
    }
    const next = template[i + 1] as string;
    if (next === "$") {
      out += "$";
      i++;
      continue;
    }
    let name = "";
    let consumed = 0;
    if (next === "{") {
      const close = template.indexOf("}", i + 2);
      if (close < 0) {
        out += c;
        continue;
      }
      name = template.slice(i + 2, close);
      consumed = close - i;
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        out += c;
        continue;
      }
    } else {
      const mm = /^[A-Za-z0-9_]+/.exec(template.slice(i + 1));
      if (!mm) {
        out += c;
        continue;
      }
      name = mm[0];
      consumed = name.length;
    }
    i += consumed;
    if (/^\d+$/.test(name)) out += m[Number(name)] ?? "";
    else out += m.groups?.[name] ?? "";
  }
  return out;
}

/** RE2 flag groups and named groups mapped onto JS RegExp. */
function compileGoRegex(pattern: string): RegExp {
  let flags = "g";
  let p = pattern;
  const lead = /^\(\?([imsU]+)\)/.exec(p);
  if (lead) {
    for (const f of (lead[1] as string).split("")) if (f !== "U" && !flags.includes(f)) flags += f;
    p = p.slice(lead[0].length);
  }
  p = p.replaceAll("(?P<", "(?<").replaceAll("\\z", "$");
  return new RegExp(p, flags);
}

async function replace(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return errorResult("no project loaded");
  const args = argsOf(req);
  const [path, pok] = stringArg(args, "path");
  if (!pok || goTrimSpace(path) === "") return errorResult("path is required");
  const [needle, nok] = stringArg(args, "needle");
  if (!nok || needle === "") return errorResult("needle is required");
  const [repl, rok] = stringArg(args, "repl");
  if (!rok) return errorResult("repl is required");
  let [mode] = stringArg(args, "mode");
  if (mode === "") mode = "literal";
  const allowMultiple = boolArg(args, "allow_multiple_occurrences");
  const root = projectRoot(project);
  let absPath: string;
  try {
    absPath = resolveProject(root, path);
    ensureCodeMutationPath(root, absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (e) {
    const { goFsError } = await import("../../platform/goerror.ts");
    return errorResult(goFsError("open", absPath, e).message);
  }
  let replacements = 0;
  let next = content;
  if (mode === "literal") {
    replacements = content.split(needle).length - 1;
    if (replacements > 1 && !allowMultiple) {
      return errorResult(
        `multiple occurrences found (${replacements}); set allow_multiple_occurrences=true`,
      );
    }
    next = content.split(needle).join(repl);
  } else if (mode === "regex") {
    let re: RegExp;
    try {
      re = compileGoRegex(needle);
    } catch (e) {
      return errorResult(`error parsing regexp: ${errMessage(e)}`);
    }
    const matches = [...content.matchAll(re)];
    replacements = matches.length;
    if (replacements > 1 && !allowMultiple) {
      return errorResult(
        `multiple occurrences found (${replacements}); set allow_multiple_occurrences=true`,
      );
    }
    next = content.replace(re, (...a) => {
      const groups =
        typeof a[a.length - 1] === "object"
          ? (a[a.length - 1] as Record<string, string>)
          : undefined;
      const arr = a.slice(
        0,
        a.findIndex((x) => typeof x === "number"),
      ) as string[];
      const m = Object.assign([...arr], { groups }) as unknown as RegExpMatchArray;
      return goExpand(repl, m);
    });
  } else {
    return errorResult("mode must be literal or regex");
  }
  try {
    writeFileSync(absPath, next);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return textResult(
    marshalIndent(goMap({ success: true, path: relPath(root, absPath), replacements, mode })),
  );
}

// --- symbol edits -----------------------------------------------------------------------------

const isCallable = (kind: number): boolean => kind === 6 || kind === 9 || kind === 12;
const symbolBareName = (name: string): string => {
  let n = goTrimSpace(name);
  const idx = n.indexOf("(");
  if (idx >= 0) n = n.slice(0, idx);
  return goTrimSpace(n);
};

function findSymbolByParts(symbols: DocumentSymbol[], parts: string[]): DocumentSymbol | undefined {
  if (parts.length === 0 || parts[0] === "") return undefined;
  for (const sym of symbols) {
    if (sym.name === parts[0]) {
      if (parts.length === 1) return sym;
      return findSymbolByParts(sym.children ?? [], parts.slice(1));
    }
    const found = findSymbolByParts(sym.children ?? [], parts);
    if (found) return found;
  }
  return undefined;
}

function collectBare(
  symbols: DocumentSymbol[],
  name: string,
  matches: DocumentSymbol[],
): DocumentSymbol[] {
  for (const sym of symbols) {
    if (isCallable(sym.kind) && symbolBareName(sym.name) === name) matches.push(sym);
    collectBare(sym.children ?? [], name, matches);
  }
  return matches;
}

/** findSymbolByName: the symbol, undefined when absent; throws when a bare name is ambiguous. */
export function findSymbolByName(
  symbols: DocumentSymbol[],
  nameIn: string,
): DocumentSymbol | undefined {
  const name = goTrimSpace(nameIn);
  const found = findSymbolByParts(symbols, name.split("."));
  if (found) return found;
  if (name === "" || name.includes(".")) return undefined;
  const matches = collectBare(symbols, name, []);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const names = matches.map((m) => m.name).sort();
  throw new Error(`symbol "${name}" is ambiguous; matches: ${names.join(", ")}`);
}

function replaceLines(path: string, start: number, endIn: number, body: string): number {
  const lines = readFileSync(path, "utf8").split("\n");
  let end = endIn;
  if (start < 0 || end < start || start >= lines.length) throw new Error("invalid symbol range");
  if (end > lines.length) end = lines.length;
  const replacement = body !== "" ? body.replace(/\n+$/, "").split("\n") : [];
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  writeFileSync(path, next.join("\n"));
  return end - start;
}

function insertLines(path: string, sym: DocumentSymbol, position: string, body: string): number {
  const lines = readFileSync(path, "utf8").split("\n");
  const insertText = body.replace(/\n+$/, "").split("\n");
  let idx = sym.range.end.line + 1;
  if (position === "before") idx = sym.range.start.line;
  if (idx < 0 || idx > lines.length) throw new Error("invalid symbol range");
  const next = [...lines.slice(0, idx), ...insertText, ...lines.slice(idx)];
  writeFileSync(path, next.join("\n"));
  return insertText.length;
}

async function notifyDidChange(
  ctx: Ctx,
  session: Session | undefined,
  path: string,
): Promise<void> {
  if (!session) return;
  await session.didChange(ctx, path, readFileSync(path, "utf8"));
}

async function locateSymbol(
  runtime: CodeRuntime,
  ctx: Ctx,
  absPath: string,
  name: string,
  withRefs: boolean,
): Promise<{ sym: DocumentSymbol; refs: Location[]; session: Session | undefined }> {
  let sym: DocumentSymbol | undefined;
  let refs: Location[] = [];
  let used: Session | undefined;
  await runtime.withSession(ctx, absPath, async (session) => {
    const syms = await session.documentSymbols(ctx, absPath);
    sym = findSymbolByName(syms, name);
    if (!sym) throw new Error(`symbol "${name}" not found`);
    if (withRefs) {
      refs = await session.references(
        ctx,
        absPath,
        sym.selectionRange.start.line,
        sym.selectionRange.start.character,
      );
    }
    used = session;
  });
  return { sym: sym as unknown as DocumentSymbol, refs, session: used };
}

async function mutationPrelude(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<{ pr: Extract<PathReq, { project: Project }>; name: string } | CallToolResult> {
  const pr = await pathRequest(state, ctx, req);
  if ("error" in pr) return errorResult(pr.error.message);
  try {
    ensureCodeMutationPath(projectRoot(pr.project), pr.absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  const [name, ok] = stringArg(argsOf(req), "symbol");
  if (!ok || goTrimSpace(name) === "") return errorResult("symbol is required");
  return { pr, name };
}

async function replaceBody(
  state: McpState,
  ctx: Ctx,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const pre = await mutationPrelude(state, ctx, req);
  if (isResult(pre)) return pre;
  const { pr, name } = pre;
  const [body, bok] = stringArg(argsOf(req), "body");
  if (!bok) return errorResult("body is required");
  let loc: Awaited<ReturnType<typeof locateSymbol>>;
  try {
    loc = await locateSymbol(pr.runtime, ctx, pr.absPath, name, false);
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "replace_body", e);
  }
  let replaced: number;
  try {
    replaced = replaceLines(pr.absPath, loc.sym.range.start.line, loc.sym.range.end.line, body);
    await notifyDidChange(ctx, loc.session, pr.absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        path: relPath(projectRoot(pr.project), pr.absPath),
        symbol: name,
        lines_replaced: replaced,
      }),
    ),
  );
}

async function insert(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<CallToolResult> {
  const pre = await mutationPrelude(state, ctx, req);
  if (isResult(pre)) return pre;
  const { pr, name } = pre;
  const args = argsOf(req);
  let [position] = stringArg(args, "position");
  if (position === "") position = "after";
  if (position !== "before" && position !== "after")
    return errorResult("position must be before or after");
  const [body, bok] = stringArg(args, "body");
  if (!bok) return errorResult("body is required");
  let loc: Awaited<ReturnType<typeof locateSymbol>>;
  try {
    loc = await locateSymbol(pr.runtime, ctx, pr.absPath, name, false);
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "insert", e);
  }
  let inserted: number;
  try {
    inserted = insertLines(pr.absPath, loc.sym, position, body);
    await notifyDidChange(ctx, loc.session, pr.absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        path: relPath(projectRoot(pr.project), pr.absPath),
        position,
        anchor: name,
        lines_inserted: inserted,
      }),
    ),
  );
}

function positionInRange(pos: { line: number; character: number }, rng: Range): boolean {
  if (pos.line < rng.start.line || pos.line > rng.end.line) return false;
  if (pos.line === rng.start.line && pos.character < rng.start.character) return false;
  if (pos.line === rng.end.line && pos.character > rng.end.character) return false;
  return true;
}

async function del(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<CallToolResult> {
  const pre = await mutationPrelude(state, ctx, req);
  if (isResult(pre)) return pre;
  const { pr, name } = pre;
  const force = boolArg(argsOf(req), "force");
  let loc: Awaited<ReturnType<typeof locateSymbol>>;
  try {
    loc = await locateSymbol(pr.runtime, ctx, pr.absPath, name, !force);
  } catch (e) {
    return codeRuntimeErrorResult(pr.runtime, pr.absPath, "delete", e);
  }
  const root = projectRoot(pr.project);
  if (!force) {
    const external: Record<string, unknown>[] = [];
    for (const ref of loc.refs) {
      const path = pathFromFileURI(ref.uri);
      if (path === pr.absPath && positionInRange(ref.range.start, loc.sym.range)) continue;
      external.push(locationResult(root, ref));
    }
    if (external.length > 0) {
      return textResult(
        marshalIndent(goMap({ error: "symbol has external references", references: external })),
      );
    }
  }
  let deleted: number;
  try {
    deleted = replaceLines(pr.absPath, loc.sym.range.start.line, loc.sym.range.end.line, "");
    await notifyDidChange(ctx, loc.session, pr.absPath);
  } catch (e) {
    return errorResult(errMessage(e));
  }
  return textResult(
    marshalIndent(
      goMap({
        success: true,
        path: relPath(root, pr.absPath),
        symbol: name,
        lines_deleted: deleted,
      }),
    ),
  );
}

// --- find -------------------------------------------------------------------------------------

const SOURCE_EXT = new Set([
  ".go",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
]);
const isSourceFile = (p: string): boolean => SOURCE_EXT.has(extname(p).toLowerCase());

function findCodeFiles(root: string, path: string): string[] {
  let base = root;
  if (goTrimSpace(path) !== "") {
    base = path;
    if (!isAbs(base)) base = join(root, base);
  }
  const info = statSync(base);
  if (!info.isDirectory()) return [base];
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status === 0 && r.stdout.length > 0) {
    const files: string[] = [];
    for (const line of goTrimSpace(r.stdout).split("\n")) {
      if (line === "") continue;
      const abs = join(base, line);
      if (isSourceFile(abs)) files.push(abs);
      if (files.length >= 200) break;
    }
    if (files.length > 0) return files;
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= 200) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= 200) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const n = e.name;
        if (
          n.startsWith(".") ||
          n === "node_modules" ||
          n === "vendor" ||
          n === "dist" ||
          n === "build"
        )
          continue;
        walk(p);
      } else if (isSourceFile(p)) files.push(p);
    }
  };
  walk(base);
  return files;
}

import { isAbsolute as isAbs } from "node:path";

function normalizeScore(score: number, max: number): number {
  if (max <= 0) return 0;
  const n = score / max;
  if (n > 1) return 1;
  if (n < 0.01 && score > 0) return 0.01;
  return Math.trunc(n * 10000 + 0.5) / 10000;
}

async function buildFileSummaries(
  ctx: Ctx,
  runtime: CodeRuntime,
  root: string,
  absPath: string,
): Promise<CodeSummary[]> {
  let syms: DocumentSymbol[] = [];
  await runtime.withSession(ctx, absPath, async (s) => {
    syms = await s.documentSymbols(ctx, absPath);
  });
  if (syms.length === 0) return [];
  const data = readFileSync(absPath, "utf8");
  return buildCodeSummaries(relative(root, absPath).split(sep).join("/"), syms, data);
}

async function find(state: McpState, ctx: Ctx, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return errorResult("no project loaded");
  const args = argsOf(req);
  const [query, qok] = stringArg(args, "query");
  if (!qok || goTrimSpace(query) === "") return errorResult("query is required");
  const runtime = await getCodeRuntime(state, ctx);
  if (!runtime) return errorResult("LSP not available for this project");
  const [path] = stringArg(args, "path");
  const includeBody = boolArg(args, "include_body");
  const verbose = boolArg(args, "verbose");
  const publicMode = "keyword";
  let [limit, lok] = intArg(args, "limit");
  if (!lok || limit <= 0) limit = 20;
  const root = projectRoot(project);
  let files: string[];
  try {
    files = findCodeFiles(root, path);
  } catch (e) {
    const { goFsError } = await import("../../platform/goerror.ts");
    return errorResult(goFsError("stat", join(root, path), e).message);
  }
  if (files.length === 0) {
    return errorResult(
      marshalIndent(
        goMap({
          error: "no_code_files",
          message:
            "keyword code search requires LSP DocumentSymbols, but no source files matched the requested path",
          mode: publicMode,
          results: [],
          total: 0,
          files_scanned: 0,
        }),
      ),
    );
  }
  const summaries: CodeSummary[] = [];
  const failedFiles: { file: string; error: string }[] = [];
  let filesWithoutSymbols = 0;
  for (const file of files) {
    let fileSummaries: CodeSummary[];
    try {
      fileSummaries = await buildFileSummaries(ctx, runtime, root, file);
    } catch (e) {
      const r = codeRuntimeErr(runtime, file, "find", e);
      if (r) return r;
      if (failedFiles.length < 5)
        failedFiles.push({ file: relPath(root, file), error: errMessage(e) });
      filesWithoutSymbols++;
      continue;
    }
    if (fileSummaries.length === 0) {
      filesWithoutSymbols++;
      continue;
    }
    summaries.push(...fileSummaries);
    if (summaries.length > 5000) break;
  }
  if (summaries.length === 0) {
    let code = "no_lsp_symbols";
    let message =
      "keyword code search requires LSP DocumentSymbols, but LSP returned no symbols for the scanned files";
    if (failedFiles.length > 0 && filesWithoutSymbols === files.length) {
      code = "lsp_symbols_unavailable";
      message =
        "keyword code search requires LSP DocumentSymbols, but LSP symbol requests failed or returned no symbols for all scanned files";
    }
    return errorResult(
      marshalIndent(
        goMap({
          error: code,
          message,
          mode: publicMode,
          results: [],
          total: 0,
          files_scanned: files.length,
          files_without_symbols: filesWithoutSymbols,
          failed_files: failedFiles,
        }),
      ),
    );
  }
  const results: CodeBM25Result[] = new CodeBM25Scorer(summaries).search(query, limit);
  let max = 0;
  for (const r of results) if (r.score > max) max = r.score;
  const out = results.map((r) => {
    const item: Record<string, unknown> = {
      name: r.name,
      full_name: r.container ? `${r.container}.${r.name}` : r.name,
      file: r.path,
      line: r.start_line,
      column: r.start_character,
      kind: r.kind,
      score: normalizeScore(r.score, max),
      body_location: goMap({ start_line: r.start_line, end_line: r.end_line }),
    };
    if (verbose) {
      item.signature = r.signature ?? "";
      item.snippet = r.snippet ?? "";
    }
    if (includeBody) {
      item.body = sourceForRange(join(root, r.path), {
        start: { line: r.start_line - 1, character: r.start_character - 1 },
        end: { line: r.end_line - 1, character: 0 },
      });
    }
    return goMap(item);
  });
  return textResult(marshalIndent(goMap({ results: out, total: out.length, mode: publicMode })));
}

void basename;
