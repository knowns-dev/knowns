// Rendering and helpers for `knowns search` and `knowns retrieve` (internal/cli/search.go). The
// result shapes come from the search library; MCP and the server do not need this file.
import type { Citation, RetrievalResponse, SearchResult } from "../../models/search.ts";
import type { SemanticIndexReadiness } from "../../search/readiness.ts";
import { goFields } from "../../search/text.ts";
import { goQuote } from "../core/gofmt.ts";
import {
  renderField,
  renderPriorityBadge,
  renderSectionHeader,
  renderStatusBadge,
  StyleBold,
  StyleDim,
  StyleID,
  StyleInfo,
  StyleLabel,
} from "../core/plainoutput.ts";
import { truncateVisible } from "./task-text.ts";

// styles.go colours: lipgloss.Color("4"), "5", "13", "6".
const colorBlue = 34;
const colorMagenta = 35;
const colorPurple = 95;
const colorCyan = 36;

/**
 * searchWarnStyle, searchDimStyle and searchSuccessStyle (search.go) are copies of the styles taken
 * at package init, so Go's --plain / NO_COLOR switch (which replaces the package-level styles)
 * never reaches them: they stay coloured in every mode. Reproduced as-is for byte parity.
 */
function sticky(fg: number, text: string): string {
  const open = `\x1b[${fg}m`;
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${open}${line}\x1b[m`))
    .join("\n");
}
export const searchWarn = (text: string): string => sticky(33, text);
export const searchDim = (text: string): string => sticky(90, text);
export const searchSuccess = (text: string): string => sticky(32, text);

/**
 * RenderBadge: "[TEXT]" in a foreground colour. Go builds a fresh lipgloss style per call, so the
 * plain / NO_COLOR switch (which replaces the package-level styles) never reaches it.
 */
export function renderBadge(text: string, fg: number): string {
  return sticky(fg, `[${text}]`);
}

/** RenderNextSteps. */
export function renderNextSteps(...steps: string[]): string {
  let b = `${StyleBold.render("Next steps:")}\n`;
  steps.forEach((s, i) => {
    b += `  ${StyleDim.render(`${i + 1}.`)} ${s}\n`;
  });
  return b;
}

/** fmt's %.<d>f of a float64: exact decimal expansion, ties to even (JS toFixed rounds ties up). */
export function goFixed(x: number, d: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "+Inf" : "-Inf";
  const neg = x < 0 || Object.is(x, -0);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const bits = buf.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let exp: number;
  if (expBits === 0) exp = -1074;
  else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  const scale = 10n ** BigInt(d);
  let q: bigint;
  if (exp >= 0) q = mant * scale * (1n << BigInt(exp));
  else {
    const num = mant * scale;
    const den = 1n << BigInt(-exp);
    q = num / den;
    const r = num % den;
    const twice = r * 2n;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  let digits = q.toString().padStart(d + 1, "0");
  if (d > 0) digits = `${digits.slice(0, -d)}.${digits.slice(-d)}`;
  return neg ? `-${digits}` : digits;
}

/** truncate: flatten whitespace, then cut to a display width without splitting a rune. */
export function truncate(s: string, maxLen: number): string {
  const flat = goFields(s.replaceAll("\n", " ")).join(" ");
  return truncateVisible(flat, maxLen);
}

export function scoreToPercent(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  let pct = Math.trunc((score / maxScore) * 100);
  if (pct > 100) pct = 100;
  if (pct < 1 && score > 0) pct = 1;
  return pct;
}

export function formatMatchedBy(methods: string[] | undefined): string {
  if (!methods || methods.length === 0) return "keyword";
  return methods.join(" + ");
}

export function formatMemoryScope(layer: string | undefined, store: string | undefined): string {
  const parts: string[] = [];
  if (layer) parts.push(layer);
  if (store) parts.push(store);
  if (parts.length === 0) return "unknown";
  return parts.join(" / ");
}

export function formatRetrievalCitation(c: Citation): string {
  return (c.path ?? "") !== "" ? `${c.type}:${c.path}` : `${c.type}:${c.id}`;
}

export interface GroupedResults {
  tasks: SearchResult[];
  docs: SearchResult[];
  memories: SearchResult[];
  decisions: SearchResult[];
  /** The task, doc, memory and decision results in their original order. */
  filtered: SearchResult[];
}

export function groupResults(results: SearchResult[]): GroupedResults {
  const g: GroupedResults = { tasks: [], docs: [], memories: [], decisions: [], filtered: [] };
  for (const r of results) {
    switch (r.type) {
      case "task":
        g.tasks.push(r);
        break;
      case "doc":
        g.docs.push(r);
        break;
      case "memory":
        g.memories.push(r);
        break;
      case "decision":
        g.decisions.push(r);
        break;
      default:
        continue;
    }
    g.filtered.push(r);
  }
  return g;
}

export function maxScoreOf(results: SearchResult[]): number {
  let max = 0;
  for (const r of results) if (r.score > max) max = r.score;
  return max;
}

export function sprintPlainResults(g: GroupedResults, maxScore: number): string {
  let b = "";
  const snippet = (r: SearchResult) =>
    (r.snippet ?? "") !== "" ? `    ${truncate(r.snippet as string, 100)}\n` : "";
  if (g.tasks.length > 0) {
    b += "Tasks:\n";
    for (const r of g.tasks) {
      b += `  #${r.id} [${r.status ?? ""}] [${r.priority ?? ""}] (${scoreToPercent(r.score, maxScore)}%)\n`;
      b += snippet(r);
      b += `    Matched by: ${formatMatchedBy(r.matchedBy)}\n`;
    }
    b += "\n";
  }
  if (g.docs.length > 0) {
    b += "Docs:\n";
    for (const r of g.docs) {
      b += `  ${r.path ?? ""} (${scoreToPercent(r.score, maxScore)}%)\n`;
      b += snippet(r);
      b += `    Matched by: ${formatMatchedBy(r.matchedBy)}\n`;
    }
    b += "\n";
  }
  if (g.memories.length > 0) {
    b += "Memories:\n";
    for (const r of g.memories) {
      b += `  ${r.id} (${scoreToPercent(r.score, maxScore)}%)\n`;
      b += snippet(r);
      b += `    Scope: ${formatMemoryScope(r.memoryLayer, r.memoryStore)}\n`;
      b += `    Matched by: ${formatMatchedBy(r.matchedBy)}\n`;
    }
    b += "\n";
  }
  if (g.decisions.length > 0) {
    b += "Decisions:\n";
    for (const r of g.decisions) {
      b += `  ${r.id} [${r.status ?? ""}] (${scoreToPercent(r.score, maxScore)}%)\n`;
      b += snippet(r);
      b += `    Matched by: ${formatMatchedBy(r.matchedBy)}\n`;
    }
    b += "\n";
  }
  return b;
}

const tagsOf = (tags: string[]): string =>
  tags.map((t) => StyleLabel.render(t)).join(StyleDim.render(", "));

export function renderPrettyResults(
  query: string,
  mode: string,
  g: GroupedResults,
  maxScore: number,
): string {
  let b = `${StyleBold.render(`Found ${g.filtered.length} result(s)`)} ${StyleDim.render("for")} ${StyleInfo.render(goQuote(query))} ${StyleDim.render(`(${mode} mode)`)}\n\n`;
  const dimSnippet = (r: SearchResult) =>
    (r.snippet ?? "") !== "" ? `    ${StyleDim.render(truncate(r.snippet as string, 100))}\n` : "";
  const pct = (r: SearchResult) => StyleDim.render(`(${scoreToPercent(r.score, maxScore)}%)`);

  if (g.tasks.length > 0) {
    b += `${renderSectionHeader("Tasks")}\n\n`;
    for (const r of g.tasks) {
      b += `  ${renderBadge("TASK", colorBlue)} ${StyleID.render(`#${r.id}`)} ${StyleBold.render(`— ${r.title}`)}  ${renderStatusBadge(r.status ?? "")} ${renderPriorityBadge(r.priority ?? "")} ${pct(r)}\n`;
      b += dimSnippet(r);
      b += `    ${StyleDim.render(`Matched by: ${formatMatchedBy(r.matchedBy)}`)}\n\n`;
    }
  }
  if (g.docs.length > 0) {
    b += `${renderSectionHeader("Docs")}\n\n`;
    for (const r of g.docs) {
      const tags = r.tags && r.tags.length > 0 ? ` ${tagsOf(r.tags)}` : "";
      b += `  ${renderBadge("DOC", colorMagenta)} ${StyleID.render(r.path ?? "")} ${StyleBold.render(`— ${r.title}`)}${tags} ${pct(r)}\n`;
      b += dimSnippet(r);
      b += `    ${StyleDim.render(`Matched by: ${formatMatchedBy(r.matchedBy)}`)}\n\n`;
    }
  }
  if (g.memories.length > 0) {
    b += `${renderSectionHeader("Memories")}\n\n`;
    for (const r of g.memories) {
      b += `  ${renderBadge("MEMORY", colorPurple)} ${StyleID.render(r.id)} ${StyleBold.render(`— ${r.title}`)} ${pct(r)}\n`;
      b += dimSnippet(r);
      b += `    ${StyleDim.render(`Scope: ${formatMemoryScope(r.memoryLayer, r.memoryStore)}`)}\n`;
      b += `    ${StyleDim.render(`Matched by: ${formatMatchedBy(r.matchedBy)}`)}\n\n`;
    }
  }
  if (g.decisions.length > 0) {
    b += `${renderSectionHeader("Decisions")}\n\n`;
    for (const r of g.decisions) {
      b += `  ${renderBadge("DECISION", colorCyan)} ${StyleID.render(r.id)} ${StyleBold.render(`— ${r.title}`)} ${renderStatusBadge(r.status ?? "")} ${pct(r)}\n`;
      b += dimSnippet(r);
      b += `    ${StyleDim.render(`Matched by: ${formatMatchedBy(r.matchedBy)}`)}\n\n`;
    }
  }
  return b;
}

const badgeColor = (type: string) =>
  type === "doc"
    ? colorMagenta
    : type === "memory"
      ? colorPurple
      : type === "decision"
        ? colorCyan
        : colorBlue;

export function sprintPlainRetrieval(resp: RetrievalResponse): string {
  const candidates = resp.candidates ?? [];
  const items = resp.contextPack.items ?? [];
  let b = `Query: ${resp.query}\n`;
  b += `Mode: ${resp.mode}\n`;
  b += `Candidates: ${candidates.length}\n`;
  b += `Context items: ${items.length}\n\n`;

  b += "Candidates:\n";
  for (const c of candidates) {
    b += `  [${c.type.toUpperCase()}] ${c.title} (${c.id})\n`;
    b += `    Score: ${goFixed(c.score, 3)}\n`;
    b += `    Direct: ${c.directMatch}\n`;
    if (c.expandedFrom && c.expandedFrom.length > 0) {
      b += `    Expanded from: ${c.expandedFrom.join(", ")}\n`;
    }
    b += `    Citation: ${formatRetrievalCitation(c.citation)}\n`;
    if (c.type === "memory") b += `    Scope: ${formatMemoryScope(c.memoryLayer, c.memoryStore)}\n`;
    if (c.type === "decision" && (c.status ?? "") !== "") b += `    Status: ${c.status}\n`;
    if ((c.snippet ?? "") !== "") b += `    ${truncate(c.snippet as string, 120)}\n`;
  }

  b += "\nContext Pack:\n";
  for (const item of items) {
    b += `  [${item.type.toUpperCase()}] ${item.title} (${item.id})\n`;
    b += `    Citation: ${formatRetrievalCitation(item.citation)}\n`;
    b += `    Direct: ${item.directMatch}\n`;
    if (item.expandedFrom && item.expandedFrom.length > 0) {
      b += `    Expanded from: ${item.expandedFrom.join(", ")}\n`;
    }
    if (item.content !== "") b += `    ${truncate(item.content, 160)}\n`;
  }
  return b;
}

export function renderPrettyRetrieval(resp: RetrievalResponse): string {
  const candidates = resp.candidates ?? [];
  const items = resp.contextPack.items ?? [];
  let b = `${StyleBold.render(`Retrieved ${candidates.length} candidate(s)`)} ${StyleDim.render("for")} ${StyleInfo.render(goQuote(resp.query))} ${StyleDim.render(`(${resp.mode} mode)`)}\n\n`;

  b += `${renderSectionHeader("Candidates")}\n\n`;
  for (const c of candidates) {
    b += `  ${renderBadge(c.type.toUpperCase(), badgeColor(c.type))} ${StyleID.render(c.id)} ${StyleBold.render(`— ${c.title}`)} ${StyleDim.render(`(${goFixed(c.score, 3)})`)}\n`;
    b += `    ${StyleDim.render(`Citation: ${formatRetrievalCitation(c.citation)}`)}\n`;
    if (c.type === "memory") {
      b += `    ${StyleDim.render(`Scope: ${formatMemoryScope(c.memoryLayer, c.memoryStore)}`)}\n`;
    }
    if (c.type === "decision" && (c.status ?? "") !== "") {
      b += `    ${StyleDim.render(`Status: ${c.status}`)}\n`;
    }
    b += `    ${StyleDim.render(`Direct match: ${c.directMatch}`)}\n`;
    if (c.expandedFrom && c.expandedFrom.length > 0) {
      b += `    ${StyleDim.render(`Expanded from: ${c.expandedFrom.join(", ")}`)}\n`;
    }
    if ((c.snippet ?? "") !== "")
      b += `    ${StyleDim.render(truncate(c.snippet as string, 120))}\n`;
    b += "\n";
  }

  b += `${renderSectionHeader("Context Pack")}\n\n`;
  for (const item of items) {
    b += `  ${renderBadge(item.type.toUpperCase(), badgeColor(item.type))} ${StyleID.render(item.id)} ${StyleBold.render(`— ${item.title}`)}\n`;
    b += `    ${StyleDim.render(`Citation: ${formatRetrievalCitation(item.citation)}`)}\n`;
    b += `    ${StyleDim.render(`Direct match: ${item.directMatch}`)}\n`;
    if (item.expandedFrom && item.expandedFrom.length > 0) {
      b += `    ${StyleDim.render(`Expanded from: ${item.expandedFrom.join(", ")}`)}\n`;
    }
    if (item.content !== "") b += `    ${StyleDim.render(truncate(item.content, 160))}\n`;
    b += "\n";
  }
  return b;
}

// --- status check --------------------------------------------------------------------------------

/** semanticReindexRemediation (internal/cli/runtime.go). */
export function semanticReindexRemediation(r: SemanticIndexReadiness): string {
  if (!r.enabled || r.optedOut) return "";
  if (r.stale || r.degraded || !r.ready) return "knowns search --reindex";
  return "";
}

/** time.Time.Format(time.RFC3339) of a stored timestamp: no fractional seconds. */
function rfc3339(ts: string): string {
  return ts.replace(/\.\d+(Z|[+-]\d{2}:\d{2})$/, "$1");
}

export function formatSearchSemanticIndexReadinessLines(r: SemanticIndexReadiness): string[] {
  let status = "ready";
  if (!r.enabled || r.optedOut) status = "keyword-only";
  else if (r.stale) status = "stale";
  else if (r.degraded || !r.ready) status = "needs reindex";

  const lines = [
    renderField("Index", `${status} (${r.chunkCount ?? 0} chunks)`),
    renderField("Backend", r.backend ?? ""),
    renderField("Mode", r.mode ?? ""),
  ];
  if ((r.model ?? "") !== "") lines.push(renderField("Index model", r.model as string));
  if ((r.dimensions ?? 0) > 0) lines.push(renderField("Index dimensions", String(r.dimensions)));
  if ((r.chunkVersion ?? 0) > 0) lines.push(renderField("Chunk version", String(r.chunkVersion)));
  if (r.indexedAt !== undefined) lines.push(renderField("Indexed at", rfc3339(r.indexedAt)));
  if ((r.reason ?? "") !== "") lines.push(renderField("Reason", r.reason as string));
  const remediation = semanticReindexRemediation(r);
  if (remediation !== "") {
    lines.push(searchWarn("    Reindex may be required after semantic provider/model changes."));
    lines.push(searchDim(`    Run: ${remediation}`));
  }
  return lines;
}
