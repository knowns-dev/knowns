// Port of internal/search/chunker.go. Chunk boundaries and ids decide the Qdrant point ids, so the
// splitting rules must stay byte-compatible with Go.
import type { DecisionEntry } from "../models/decision.ts";
import { type MemoryEntry, stripMemoryDetailMarker } from "../models/memory.ts";
import type { Task } from "../models/task.ts";
import { goTrimSpace } from "./text.ts";
import type { Chunk, ChunkResult, Tokenizer } from "./types.ts";

// RE2's \s is [\t\n\f\r ]; JS's is Unicode-wide, so the class is spelled out.
const TOKEN_PIECES =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\t\n\f\r \p{L}\p{N}]+|[\t\n\f\r ]+/gu;

/** Approximates the token count by counting BPE pre-tokenizer pieces (EstimateTokens). */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  const n = text.match(TOKEN_PIECES)?.length ?? 0;
  return n === 0 ? 1 : n;
}

function countTokens(text: string, tok: Tokenizer | undefined): number {
  if (!tok) return estimateTokens(text);
  return tok.encode(text, 999999).inputIds.length;
}

interface MarkdownHeading {
  level: number;
  title: string;
  headerPath: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

// `.` in RE2 matches \r; JS's does not, so CRLF documents need an explicit class.
const HEADING_RE = /^(#{1,6})[\t\n\f\r ]+([^\n]+)$/;

export function extractHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split("\n");
  const headings: MarkdownHeading[] = [];
  let current: MarkdownHeading | undefined;
  let inCodeBlock = false;
  const stack: { level: number; title: string }[] = [];

  // Prefix sums of line lengths (+1 for the newline) avoid Go's quadratic re-summing.
  const offsets: number[] = new Array(lines.length + 1);
  offsets[0] = 0;
  for (let j = 0; j < lines.length; j++) {
    offsets[j + 1] = (offsets[j] as number) + (lines[j] as string).length + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (goTrimSpace(line).startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const level = (m[1] as string).length;
    const title = goTrimSpace(m[2] as string);
    while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) {
      stack.pop();
    }
    stack.push({ level, title });
    const headerPath = stack.map((e) => e.title).join("/");

    if (current) {
      const endIdx = offsets[i] as number;
      current.content = goTrimSpace(markdown.slice(current.startIndex, endIdx));
      current.endIndex = endIdx;
      headings.push(current);
    }
    let startIdx = offsets[i + 1] as number;
    if (startIdx > markdown.length) startIdx = markdown.length;
    current = {
      level,
      title,
      headerPath,
      content: "",
      startIndex: startIdx,
      endIndex: markdown.length,
    };
  }
  if (current) {
    current.content = goTrimSpace(markdown.slice(current.startIndex));
    current.endIndex = markdown.length;
    headings.push(current);
  }
  return headings;
}

const PARAGRAPH_SPLIT = /\n\n+/;

export function splitParagraphs(text: string): string[] {
  return text
    .split(PARAGRAPH_SPLIT)
    .map(goTrimSpace)
    .filter((p) => p !== "");
}

/** Splits a document into chunks by headings. */
export function chunkDocument(
  content: string,
  path: string,
  title: string,
  description: string,
  maxTokens: number,
  tok?: Tokenizer,
): ChunkResult {
  if (maxTokens <= 0) maxTokens = 512;
  const chunks: Chunk[] = [];
  let totalTokens = 0;

  let metaContent = title;
  if (description !== "") metaContent = `${title}\n\n${description}`;
  const metaTokens = countTokens(metaContent, tok);
  const meta: Chunk = {
    id: `doc:${path}:chunk:0`,
    type: "doc",
    docPath: path,
    section: "# Metadata",
    content: metaContent,
    tokenCount: metaTokens,
    headingLevel: 1,
    position: 0,
  };
  chunks.push(meta);
  totalTokens += metaTokens;

  const headings = extractHeadings(content);
  let position = 1;

  for (const h of headings) {
    if (h.level === 1 && goTrimSpace(h.content) !== "") {
      metaContent += `\n\n${goTrimSpace(h.content)}`;
      break;
    }
  }
  meta.content = metaContent;
  meta.tokenCount = countTokens(metaContent, tok);

  const push = (c: Chunk) => {
    chunks.push(c);
    totalTokens += c.tokenCount;
    position++;
  };
  const sectionChunk = (
    h: MarkdownHeading,
    sectionTitle: string,
    body: string,
    tokens: number,
  ) => ({
    id: `doc:${path}:chunk:${position}`,
    type: "doc" as const,
    docPath: path,
    section: sectionTitle,
    content: body,
    tokenCount: tokens,
    headingLevel: h.level,
    headerPath: h.headerPath,
    position,
  });

  for (const h of headings) {
    if (h.level === 1) continue;
    const sectionTitle = `${"#".repeat(h.level)} ${h.title}`;
    const sectionContent = `${sectionTitle}\n\n${h.content}`;
    const tokenCount = countTokens(sectionContent, tok);

    if (tokenCount > maxTokens) {
      let currentContent = sectionTitle;
      let currentTokens = countTokens(sectionTitle, tok);
      for (const para of splitParagraphs(h.content)) {
        const paraTokens = countTokens(para, tok);
        if (currentTokens + paraTokens > maxTokens && currentContent !== sectionTitle) {
          push(sectionChunk(h, sectionTitle, currentContent, currentTokens));
          currentContent = `${sectionTitle} (continued)\n\n${para}`;
          currentTokens = countTokens(currentContent, tok);
        } else {
          currentContent += `\n\n${para}`;
          currentTokens += paraTokens;
        }
      }
      if (currentContent !== sectionTitle) {
        push(sectionChunk(h, sectionTitle, currentContent, currentTokens));
      }
    } else {
      push(sectionChunk(h, sectionTitle, sectionContent, tokenCount));
    }
  }

  if (headings.length === 0 && goTrimSpace(content) !== "") {
    const ct = countTokens(content, tok);
    chunks.push({
      id: `doc:${path}:chunk:1`,
      type: "doc",
      docPath: path,
      section: "# Content",
      content,
      tokenCount: ct,
      headingLevel: 1,
      position: 1,
    });
    totalTokens += ct;
  }
  return { chunks, totalTokens };
}

function taskFieldContent(task: Task, field: string): string {
  switch (field) {
    case "description":
      return task.description ? `${task.title}\n\n${task.description}` : task.title;
    case "ac": {
      const acs = task.acceptanceCriteria ?? [];
      if (acs.length === 0) return "";
      return acs.map((ac) => `- ${ac.completed ? "[x]" : "[ ]"} ${ac.text}`).join("\n");
    }
    case "plan":
      return task.implementationPlan ?? "";
    case "notes":
      return task.implementationNotes ?? "";
    default:
      return "";
  }
}

/**
 * The shared paragraph packer behind task, memory and decision chunks: fill a chunk until the next
 * paragraph would overflow, then start another, numbering the extra parts ":1", ":2", ...
 */
function packParagraphs(
  text: string,
  maxTokens: number,
  tok: Tokenizer | undefined,
  make: (suffix: string, content: string, tokens: number) => Chunk,
): { chunks: Chunk[]; total: number } {
  const chunks: Chunk[] = [];
  let total = 0;
  let partIdx = 0;
  let currentContent = "";
  let currentTokens = 0;
  const flush = () => {
    chunks.push(make(partIdx > 0 ? `:${partIdx}` : "", currentContent, currentTokens));
    total += currentTokens;
  };
  for (const para of splitParagraphs(text)) {
    const paraTokens = countTokens(para, tok);
    if (currentTokens + paraTokens > maxTokens && currentContent !== "") {
      flush();
      partIdx++;
      currentContent = para;
      currentTokens = paraTokens;
    } else {
      currentContent = currentContent !== "" ? `${currentContent}\n\n${para}` : para;
      currentTokens += paraTokens;
    }
  }
  if (currentContent !== "") flush();
  return { chunks, total };
}

/** Splits a task into chunks by field; long fields split by paragraph. */
export function chunkTask(task: Task, maxTokens: number, tok?: Tokenizer): ChunkResult {
  if (maxTokens <= 0) maxTokens = 512;
  const chunks: Chunk[] = [];
  let totalTokens = 0;
  const base = (field: string, suffix: string, content: string, tokens: number): Chunk => ({
    id: `task:${task.id}:chunk:${field}${suffix}`,
    type: "task",
    taskId: task.id,
    field,
    content,
    tokenCount: tokens,
    status: task.status,
    priority: task.priority,
    ...(task.labels && task.labels.length > 0 ? { labels: task.labels } : {}),
  });
  for (const field of ["description", "ac", "plan", "notes"]) {
    const content = taskFieldContent(task, field);
    if (content === "") continue;
    const tc = countTokens(content, tok);
    if (tc > maxTokens) {
      const packed = packParagraphs(content, maxTokens, tok, (s, c, t) => base(field, s, c, t));
      chunks.push(...packed.chunks);
      totalTokens += packed.total;
    } else {
      chunks.push(base(field, "", content, tc));
      totalTokens += tc;
    }
  }
  return { chunks, totalTokens };
}

export function chunkMemory(entry: MemoryEntry, maxTokens: number, tok?: Tokenizer): ChunkResult {
  if (maxTokens <= 0) maxTokens = 512;
  let text = entry.title !== "" ? entry.title : "";
  if (entry.category) text += ` [${entry.category}]`;
  if (entry.content) {
    if (text !== "") text += "\n\n";
    // The claim-boundary marker is a display directive and never reaches the index.
    text += stripMemoryDetailMarker(entry.content);
  }
  if (text === "") return { chunks: [], totalTokens: 0 };
  const make = (suffix: string, content: string, tokens: number): Chunk => ({
    id: `memory:${entry.id}:chunk:content${suffix}`,
    type: "memory",
    memoryId: entry.id,
    memoryLayer: entry.layer,
    memoryStore: entry.layer,
    content,
    tokenCount: tokens,
  });
  const tc = countTokens(text, tok);
  if (tc > maxTokens) {
    const packed = packParagraphs(text, maxTokens, tok, make);
    return { chunks: packed.chunks, totalTokens: packed.total };
  }
  return { chunks: [make("", text, tc)], totalTokens: tc };
}

export function chunkDecision(
  entry: DecisionEntry | undefined,
  maxTokens: number,
  tok?: Tokenizer,
): ChunkResult {
  if (!entry) return { chunks: [], totalTokens: 0 };
  if (maxTokens <= 0) maxTokens = 512;
  const text = decisionText(entry);
  if (text === "") return { chunks: [], totalTokens: 0 };
  const make = (suffix: string, content: string, tokens: number): Chunk => ({
    id: `decision:${entry.id}:chunk:content${suffix}`,
    type: "decision",
    decisionId: entry.id,
    status: entry.status,
    content,
    tokenCount: tokens,
  });
  const tc = countTokens(text, tok);
  if (tc > maxTokens) {
    const packed = packParagraphs(text, maxTokens, tok, make);
    return { chunks: packed.chunks, totalTokens: packed.total };
  }
  return { chunks: [make("", text, tc)], totalTokens: tc };
}

/** decisionText: the flattened decision used for embedding, keyword scoring and context. */
export function decisionText(entry: DecisionEntry | undefined): string {
  if (!entry) return "";
  const parts = [entry.title];
  if (entry.status) parts.push(`Status: ${entry.status}`);
  if (entry.tags && entry.tags.length > 0) parts.push(`Tags: ${entry.tags.join(", ")}`);
  if (entry.sources && entry.sources.length > 0) parts.push(`Sources: ${entry.sources.join(", ")}`);
  if (entry.relatedDocs && entry.relatedDocs.length > 0) {
    parts.push(`Related docs: ${entry.relatedDocs.join(", ")}`);
  }
  if (entry.relatedTasks && entry.relatedTasks.length > 0) {
    parts.push(`Related tasks: ${entry.relatedTasks.join(", ")}`);
  }
  const sections: [string, string | undefined][] = [
    ["Context", entry.context],
    ["Decision", entry.decision],
    ["Alternatives Considered", entry.alternativesConsidered],
    ["Consequences", entry.consequences],
    ["Content", entry.content],
  ];
  for (const [heading, body] of sections) {
    if (goTrimSpace(body ?? "") === "") continue;
    parts.push(`## ${heading}\n\n${body}`);
  }
  return goTrimSpace(parts.join("\n\n"));
}
