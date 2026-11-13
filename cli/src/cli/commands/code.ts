// `knowns code` (internal/cli/code.go): code intelligence over the LSP manager and the semantic index.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { exactArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { printContent } from "../core/pager.ts";
import { renderField, StyleBold, StyleDim, StyleWarning } from "../core/plainoutput.ts";

// RenderBadge uses a bare lipgloss style, so it colors even under --plain (unlike the Style vars).
const badgeBlue = 34;
const badgeMagenta = 35;
const badge = (text: string, color: number): string => `\x1b[${color}m[${text}]\x1b[m`;

function emit(ctx: CommandContext, text: string): void {
  if (ctx.plain) ctx.printPaged(text);
  else printContent(ctx.cmd, text);
}

/** SemanticDB(): a read-only handle, or undefined when the index file is missing. */
async function openSemanticDb(ctx: CommandContext) {
  const store = await ctx.getStore();
  const dbPath = join(store.root, ".search", "index.db");
  if (!existsSync(dbPath)) return undefined;
  const { Database } = await import("bun:sqlite");
  return new Database(dbPath, { readonly: true });
}

function sqlError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table|no such column|syntax error/.test(msg)
    ? new Error(`SQL logic error: ${msg} (1)`)
    : new Error(msg);
}

const deps = defineCommand({
  use: "deps",
  short: "Inspect code dependency data",
  flags: [
    { type: "string", name: "type", usage: "Filter dependency edges by type", default: "" },
    { type: "int", name: "limit", usage: "Limit dependency results", default: 200 },
  ],
  async run(ctx) {
    const db = await openSemanticDb(ctx);
    if (!db) {
      if (ctx.json) ctx.printJSON([]);
      else
        ctx.print(
          `${StyleWarning.render("⚠ No code dependency index found. Run 'knowns code ingest' first.")}\n`,
        );
      return;
    }
    const typeFilter = ctx.flags.string("type");
    let limit = ctx.flags.int("limit");
    if (limit <= 0) limit = 200;
    let rows: Record<string, string>[];
    try {
      rows = db
        .query(
          "SELECT from_id, to_id, edge_type, from_path, to_path, raw_target, resolution_status, resolution_confidence FROM code_edges WHERE (? = '' OR edge_type = ?) ORDER BY from_id, edge_type, to_id LIMIT ?",
        )
        .all(typeFilter, typeFilter, limit) as Record<string, string>[];
    } catch (e) {
      throw sqlError(e);
    } finally {
      db.close();
    }
    const items = rows.map((r) => ({
      confidence: String(r.resolution_confidence ?? ""),
      from: String(r.from_id ?? ""),
      fromPath: String(r.from_path ?? ""),
      rawTarget: String(r.raw_target ?? ""),
      status: String(r.resolution_status ?? ""),
      to: String(r.to_id ?? ""),
      toPath: String(r.to_path ?? ""),
      type: String(r.edge_type ?? ""),
    }));
    if (ctx.json) {
      ctx.printJSON(items);
      return;
    }
    let b = `${StyleBold.render("Code Dependencies")}\n\n`;
    b += `${renderField("Edges", String(items.length))}\n`;
    if (typeFilter !== "") b += `${renderField("Type filter", typeFilter)}\n`;
    b += "\n";
    for (const item of items) {
      b += `  ${badge(item.type.toUpperCase(), badgeBlue)} ${StyleBold.render(`${item.from} -> ${item.to}`)}\n`;
      if (item.fromPath !== "") b += `    ${StyleDim.render(`from: ${item.fromPath}`)}\n`;
      if (item.toPath !== "") b += `    ${StyleDim.render(`to: ${item.toPath}`)}\n`;
      if (item.rawTarget !== "") b += `    ${StyleDim.render(`target: ${item.rawTarget}`)}\n`;
      if (item.status !== "" || item.confidence !== "") {
        b += `    ${StyleDim.render(`resolution: ${item.status} ${item.confidence}`)}\n`;
      }
      b += "\n";
    }
    emit(ctx, b);
  },
});

const symbols = defineCommand({
  use: "symbols",
  short: "Inspect indexed code symbols",
  flags: [
    { type: "string", name: "path", usage: "Filter symbols by file path", default: "" },
    { type: "string", name: "kind", usage: "Filter symbols by kind", default: "" },
    { type: "int", name: "limit", usage: "Limit symbol results", default: 100 },
  ],
  async run(ctx) {
    const db = await openSemanticDb(ctx);
    if (!db) {
      if (ctx.json) ctx.printJSON([]);
      else
        ctx.print(
          `${StyleWarning.render("⚠ No code symbol index found. Run 'knowns code ingest' first.")}\n`,
        );
      return;
    }
    const pathFilter = ctx.flags.string("path");
    const kindFilter = ctx.flags.string("kind");
    let limit = ctx.flags.int("limit");
    if (limit <= 0) limit = 100;
    let rows: Record<string, string>[];
    try {
      rows = db
        .query(
          "SELECT id, doc_path, field, COALESCE(name, ''), COALESCE(signature, '') FROM chunks WHERE type = 'code' AND (? = '' OR doc_path = ?) AND (? = '' OR field = ?) ORDER BY doc_path, name, id LIMIT ?",
        )
        .values(pathFilter, pathFilter, kindFilter, kindFilter, limit)
        .map((v) => ({
          id: v[0],
          doc_path: v[1],
          field: v[2],
          name: v[3],
          signature: v[4],
        })) as Record<string, string>[];
    } catch (e) {
      throw sqlError(e);
    } finally {
      db.close();
    }
    const items = rows.map((r) => ({
      id: String(r.id ?? ""),
      kind: String(r.field ?? ""),
      name: String(r.name ?? ""),
      path: String(r.doc_path ?? ""),
      signature: String(r.signature ?? ""),
    }));
    if (ctx.json) {
      ctx.printJSON(items);
      return;
    }
    let b = `${StyleBold.render("Code Symbols")}\n\n`;
    b += `${renderField("Symbols", String(items.length))}\n`;
    if (pathFilter !== "") b += `${renderField("Path filter", pathFilter)}\n`;
    if (kindFilter !== "") b += `${renderField("Kind filter", kindFilter)}\n`;
    b += "\n";
    for (const item of items) {
      const name = item.name === "" ? item.id : item.name;
      b += `  ${badge(item.kind.toUpperCase(), badgeMagenta)} ${StyleBold.render(name)}\n`;
      b += `    ${StyleDim.render(`path: ${item.path}`)}\n`;
      if (item.signature !== "") b += `    ${StyleDim.render(item.signature)}\n`;
      b += "\n";
    }
    emit(ctx, b);
  },
});

function codeScoreNorm(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  const n = score / maxScore;
  if (n > 1) return 1;
  if (n < 0.01 && score > 0) return 0.01;
  return Math.trunc(n * 10000 + 0.5) / 10000;
}

const search = defineCommand({
  use: "search <query>",
  short: "Keyword search across LSP code symbols",
  args: exactArgs(1),
  flags: [
    {
      type: "string",
      name: "path",
      usage: "Search within a specific file or directory",
      default: "",
    },
    { type: "int", name: "limit", usage: "Limit search results", default: 20 },
  ],
  async run(ctx) {
    const query = ctx.args[0] as string;
    const path = ctx.flags.string("path");
    let limit = ctx.flags.int("limit");
    if (limit <= 0) limit = 20;
    const root = (await ctx.getStore()).projectRoot;

    const { getLSPManagerForRoot } = await import("../../lsp/project.ts");
    const { extractFileLSP, findSourceFiles } = await import("../../lsp/code-extract.ts");
    const { CodeBM25Scorer } = await import("../../lsp/code-search.ts");
    const mgr = await getLSPManagerForRoot(root, (l) => ctx.printErr(l));
    const summaries: Awaited<ReturnType<typeof extractFileLSP>> = [];
    try {
      let targets: string[];
      if (path === "") targets = findSourceFiles(root);
      else {
        const abs = isAbsolute(path) ? path : join(root, path);
        try {
          targets = statSync(abs).isDirectory() ? findSourceFiles(abs) : [abs];
        } catch {
          targets = [];
        }
      }
      for (const file of targets) {
        summaries.push(...(await extractFileLSP(undefined, mgr, root, file)));
        if (summaries.length > 5000) break;
      }
    } finally {
      const { withTimeout } = await import("../../lsp/context.ts");
      const t = withTimeout(undefined, 5000);
      await mgr.stopAll(t.ctx);
      t.cancel();
    }

    const mode = "keyword";
    const results = new CodeBM25Scorer(summaries).search(query, limit);
    const maxScore = results.reduce((m, r) => Math.max(m, r.score), 0);
    const items = results.map((r) => {
      const item: Record<string, unknown> = {};
      if (r.container) item.container = r.container;
      item.kind = r.kind;
      item.line = r.start_line;
      item.name = r.name;
      item.path = r.path;
      item.score = codeScoreNorm(r.score, maxScore);
      if (r.signature) item.signature = r.signature;
      item.snippet = r.snippet ?? "";
      return item;
    });
    if (ctx.json) {
      ctx.printJSON({ mode, results: items, total: items.length });
      return;
    }
    let b = `${StyleBold.render("Code Search")}\n\n`;
    b += `${renderField("Query", query)}\n`;
    b += `${renderField("Mode", mode)}\n`;
    b += `${renderField("Results", String(items.length))}\n\n`;
    for (const item of items) {
      let name = String(item.name);
      const container = item.container === undefined ? "<nil>" : String(item.container);
      if (container !== "") name = `${container}.${name}`;
      b += `  ${badge(String(item.kind).toUpperCase(), badgeBlue)} ${StyleBold.render(name)}\n`;
      b += `    ${StyleDim.render(`path: ${item.path}`)}:${item.line}\n`;
      // fmt.Sprint(nil) is "<nil>", which Go then prints as a signature line.
      const sig = item.signature === undefined ? "<nil>" : String(item.signature);
      if (sig !== "") b += `    ${StyleDim.render(sig)}\n`;
      const snip = String(item.snippet ?? "");
      if (snip !== "") b += `    ${StyleDim.render(snip)}\n`;
      b += `    ${StyleDim.render(`score: ${(item.score as number).toFixed(4)}`)}\n\n`;
    }
    emit(ctx, b);
  },
});

export default defineCommand({
  use: "code",
  short: "Code intelligence commands",
  long: `Code intelligence commands for AST-based indexing and graph analysis.

Recommended context flow:
  1. Use 'knowns code search <query>' for keyword code discovery across LSP symbols.
  2. Use 'knowns code symbols' to verify what was actually indexed in a file or scope.
  3. Use 'knowns code deps' to inspect raw relationships such as calls, imports, ownership, and inheritance.

Examples:
  knowns code search "login auth"
  knowns code search "handleCodeDefinition" --path internal/mcp
  knowns code deps --type calls
  knowns code symbols --kind function`,
  subcommands: [deps, symbols, search],
});
