// Port of internal/search/code_bm25.go: BM25 lexical search over LSP-derived code summaries.
import { bm25Tokenize } from "../search/lexical.ts";
import type { DocumentSymbol, Range } from "./types.ts";

const bm25K1 = 1.2;
const bm25B = 0.75;

const symbolKindNames: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** codeSymbolKindString converts an LSP SymbolKind code to its name. */
export function codeSymbolKindString(kind: number): string {
  return symbolKindNames[kind] ?? "Unknown";
}

export interface CodeSummary {
  name: string;
  kind: string;
  container: string;
  signature: string;
  path: string;
  package: string;
  comments: string;
  relationships: string;
  startLine: number;
  endLine: number;
  startCharacter: number;
  selectionStart: number;
  selectionChar: number;
}

/** CodeBM25Result; the JSON names match Go's struct tags. */
export interface CodeBM25Result {
  name: string;
  kind: string;
  container?: string;
  signature?: string;
  path: string;
  package?: string;
  start_line: number;
  end_line: number;
  start_character: number;
  selection_start: number;
  selection_char: number;
  score: number;
  snippet?: string;
}

function truncateStr(s: string, maxLen: number): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= maxLen) return s;
  if (maxLen <= 3) return b.subarray(0, maxLen).toString("utf8");
  return `${b.subarray(0, maxLen - 3).toString("utf8")}...`;
}

export function packageFromPath(path: string): string {
  if (path === "") return "";
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function extractComments(lines: string[], startLine: number): string {
  if (startLine <= 0 || startLine >= lines.length) return "";
  const comments: string[] = [];
  for (let i = startLine - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (line === "") break;
    if (
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#")
    ) {
      comments.unshift(line);
    } else {
      break;
    }
  }
  return comments.join(" ");
}

const relKeywords: [string, string][] = [
  ["func ", "calls"],
  [".", "method_access"],
  ["import ", "imports"],
  ["implements", "implements"],
  ["extends", "extends"],
  ["interface", "interface"],
  ["struct ", "struct"],
  ["type ", "type_def"],
];

function extractRelationships(lines: string[], rng: Range): string {
  const start = rng.start.line;
  let end = rng.end.line;
  if (start < 0 || start >= lines.length) return "";
  if (end >= lines.length) end = lines.length - 1;
  const body = lines
    .slice(start, end + 1)
    .join(" ")
    .toLowerCase();
  const rels: string[] = [];
  for (const [keyword, label] of relKeywords) if (body.includes(keyword)) rels.push(label);
  return rels.join(",");
}

function collectSymbols(
  path: string,
  pkg: string,
  parent: string,
  symbols: DocumentSymbol[],
  lines: string[],
  out: CodeSummary[],
): void {
  for (const sym of symbols) {
    const container = parent === "" ? pkg : parent;
    out.push({
      name: sym.name,
      kind: codeSymbolKindString(sym.kind),
      container,
      signature: sym.detail ?? "",
      path,
      package: pkg,
      comments: extractComments(lines, sym.range.start.line),
      relationships: extractRelationships(lines, sym.range),
      startLine: sym.range.start.line + 1,
      endLine: sym.range.end.line + 1,
      startCharacter: sym.range.start.character + 1,
      selectionStart: sym.selectionRange.start.line + 1,
      selectionChar: sym.selectionRange.start.character + 1,
    });
    const childParent = parent !== "" ? `${parent}.${sym.name}` : sym.name;
    collectSymbols(path, pkg, childParent, sym.children ?? [], lines, out);
  }
}

/** BuildCodeSummaries builds BM25-indexable summaries from LSP DocumentSymbols. */
export function buildCodeSummaries(
  relPath: string,
  symbols: DocumentSymbol[],
  source: string,
): CodeSummary[] {
  const out: CodeSummary[] = [];
  collectSymbols(relPath, packageFromPath(relPath), "", symbols, source.split("\n"), out);
  return out;
}

function codeSnippet(sym: CodeSummary): string {
  if (sym.signature !== "") return truncateStr(sym.signature, 120);
  if (sym.comments !== "") return truncateStr(sym.comments, 120);
  return `${sym.kind} ${sym.name}`;
}

function bm25IDF(n: number, df: number): number {
  return 1.0 + (n - df + 0.5) / (df + 0.5);
}

function summaryContainsToken(sym: CodeSummary, token: string): boolean {
  const text =
    `${sym.name} ${sym.kind} ${sym.container} ${sym.signature} ${sym.path} ${sym.package} ${sym.comments} ${sym.relationships}`.toLowerCase();
  return text.includes(token);
}

function corpusStats(summaries: CodeSummary[], queryTokens: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const n = summaries.length;
  if (n === 0) return idf;
  for (const token of queryTokens) {
    let df = 0;
    for (const sym of summaries) if (summaryContainsToken(sym, token)) df++;
    if (df > 0) idf.set(token, bm25IDF(n, df));
  }
  return idf;
}

function rerankBoost(sym: CodeSummary, queryTokens: string[]): number {
  let boost = 0;
  const queryLower = queryTokens.join(" ").toLowerCase();
  const nameLower = sym.name.toLowerCase();
  if (nameLower === queryLower) boost += 10;
  else if (nameLower.startsWith(queryLower)) boost += 6;
  else if (nameLower.includes(queryLower)) boost += 4;
  if (sym.container.toLowerCase() === queryLower) boost += 5;
  const pathLower = sym.path.toLowerCase();
  for (const token of queryTokens) {
    if (pathLower.includes(token)) {
      boost += 2;
      break;
    }
  }
  const commentsLower = sym.comments.toLowerCase();
  for (const kw of ["login", "auth", "authenticate", "token", "session", "credential"]) {
    if (commentsLower.includes(kw) && queryTokens.includes(kw)) {
      boost += 3;
      break;
    }
  }
  return boost;
}

function score(sym: CodeSummary, queryTokens: string[], idf: Map<string, number>): number {
  let total = 0;
  const fields: [string, number][] = [
    [sym.name, 5.0],
    [sym.container, 3.0],
    [sym.signature, 2.5],
    [sym.comments, 2.0],
    [sym.path, 1.5],
    [sym.relationships, 1.2],
    [sym.package, 1.0],
    [sym.kind, 0.8],
  ];
  for (const [text, weight] of fields) {
    if (text === "") continue;
    const fieldTokens = bm25Tokenize(text);
    const fieldLen = fieldTokens.length;
    if (fieldLen === 0) continue;
    for (const token of queryTokens) {
      let tf = 0;
      for (const ft of fieldTokens) if (ft === token) tf++;
      if (tf === 0) continue;
      const tokenIDF = idf.get(token) ?? 0;
      if (tokenIDF === 0) continue;
      const denom = tf + bm25K1 * (1 - bm25B + bm25B * (fieldLen / queryTokens.length));
      total += weight * tokenIDF * ((tf * (bm25K1 + 1)) / denom);
    }
  }
  return total + rerankBoost(sym, queryTokens);
}

export class CodeBM25Scorer {
  constructor(private readonly summaries: CodeSummary[]) {}

  search(query: string, limitIn: number): CodeBM25Result[] {
    if (query === "") return [];
    const queryTokens = bm25Tokenize(query);
    if (queryTokens.length === 0) return [];
    const limit = limitIn <= 0 ? 20 : limitIn;
    const stats = corpusStats(this.summaries, queryTokens);
    let results: CodeBM25Result[] = [];
    for (const sym of this.summaries) {
      const s = score(sym, queryTokens, stats);
      if (s <= 0) continue;
      const r: CodeBM25Result = {
        name: sym.name,
        kind: sym.kind,
        path: sym.path,
        start_line: sym.startLine,
        end_line: sym.endLine,
        start_character: sym.startCharacter,
        selection_start: sym.selectionStart,
        selection_char: sym.selectionChar,
        score: s,
      };
      if (sym.container !== "") r.container = sym.container;
      if (sym.signature !== "") r.signature = sym.signature;
      if (sym.package !== "") r.package = sym.package;
      const snip = codeSnippet(sym);
      if (snip !== "") r.snippet = snip;
      results.push(r);
    }
    results.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    if (results.length > limit) results = results.slice(0, limit);
    return results;
  }
}
