import { normalizeKnownsTaskReferences } from "../../lib/knownsReferences";

const TASK_MENTION_REGEX = /@(task[-/][a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?(?:\{[a-z-]+\})?)/g;
const MEMORY_MENTION_REGEX = /@(memory[-/][a-zA-Z0-9-]+(?:\{[a-z-]+\})?)/g;
const DECISION_MENTION_REGEX = /@(decision\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\{[a-z-]+\})?)/g;
const TEMPLATE_MENTION_REGEX = /@(template\/[a-zA-Z0-9_./-]+(?:\{[a-z-]+\})?)/g;
const DOC_MENTION_REGEX = /@docs?\/([^\s,;!?"'(){}]+(?:\{[a-z-]+\})?)/g;
const KNOWNS_DOC_PATH_REGEX = /(^|[\s(])(\.knowns\/docs\/[^\s,;!?"'()]+\.md)\b/g;
const SEMANTIC_LINK_PREFIX = "knowns-ref:";

function stripDocExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function splitRelationSuffix(value: string): { body: string; relationSuffix: string } {
  const match = value.match(/(\{[a-z-]+\})$/);
  if (!match || !match[1]) {
    return { body: value, relationSuffix: "" };
  }
  return {
    body: value.slice(0, -match[1].length),
    relationSuffix: match[1],
  };
}

function trimTrailingDocPunctuation(value: string): string {
  let trimmed = value.replace(/[:]+$/, "");
  if (trimmed.endsWith(".") && !/\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function normalizeDocPath(path: string): string {
  return path.endsWith(".md") ? path : `${path}.md`;
}

export function toDocPath(path: string): string {
  let normalized = path.trim();

  const queryIndex = normalized.indexOf("?");
  const hashIndex = normalized.indexOf("#");
  const splitIndex = queryIndex >= 0 ? queryIndex : hashIndex >= 0 ? hashIndex : -1;
  let suffix = "";
  if (splitIndex >= 0) {
    suffix = normalized.slice(splitIndex);
    normalized = normalized.slice(0, splitIndex);
  }

  if (normalized.startsWith("@doc/")) {
    normalized = normalized.slice(5);
  } else if (normalized.startsWith("@docs/")) {
    normalized = normalized.slice(6);
  } else if (normalized.startsWith(".knowns/docs/")) {
    normalized = normalized.slice(".knowns/docs/".length);
  } else if (normalized.startsWith("/.knowns/docs/")) {
    normalized = normalized.slice("/.knowns/docs/".length);
  } else if (normalized.startsWith("docs/")) {
    normalized = normalized.slice("docs/".length);
  } else if (normalized.startsWith("/docs/")) {
    normalized = normalized.slice("/docs/".length);
  } else if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }

  if (suffix) {
    const rangeMatch = suffix.match(/^\?L=(\d+)-(\d+)/);
    const lineMatch = !rangeMatch && suffix.match(/^\?L=(\d+)/);
    const headingMatch = !rangeMatch && !lineMatch && suffix.match(/^#(.+)/);
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      normalized = `${normalizeDocPath(normalized)}:${rangeMatch[1]}-${rangeMatch[2]}`;
      return normalized;
    }
    if (lineMatch && lineMatch[1]) {
      normalized = `${normalizeDocPath(normalized)}:${lineMatch[1]}`;
      return normalized;
    }
    if (headingMatch && headingMatch[1]) {
      normalized = `${normalizeDocPath(normalized)}#${headingMatch[1]}`;
      return normalized;
    }
  }

  return normalizeDocPath(normalized);
}

export function normalizeSemanticDocTarget(rawTarget: string): string {
  let normalized = rawTarget.trim();

  if (normalized.startsWith("@doc/")) {
    normalized = normalized.slice(5);
  } else if (normalized.startsWith("@docs/")) {
    normalized = normalized.slice(6);
  } else if (normalized.startsWith(".knowns/docs/")) {
    normalized = normalized.slice(".knowns/docs/".length);
  } else if (normalized.startsWith("/.knowns/docs/")) {
    normalized = normalized.slice("/.knowns/docs/".length);
  }

  const { body, relationSuffix } = splitRelationSuffix(normalized);
  let cleanPath = trimTrailingDocPunctuation(body);
  let fragment = "";

  const rangeMatch = cleanPath.match(/:(\d+)-(\d+)$/);
  const lineMatch = !rangeMatch && cleanPath.match(/:(\d+)$/);
  const headingMatch = !rangeMatch && !lineMatch && cleanPath.match(/#([a-zA-Z0-9_-]+(?:[a-zA-Z0-9_. -]*)?)$/);

  if (rangeMatch) {
    fragment = `:${rangeMatch[1]}-${rangeMatch[2]}`;
    cleanPath = cleanPath.slice(0, -rangeMatch[0].length);
  } else if (lineMatch) {
    fragment = `:${lineMatch[1]}`;
    cleanPath = cleanPath.slice(0, -lineMatch[0].length);
  } else if (headingMatch) {
    fragment = `#${headingMatch[1]}`;
    cleanPath = cleanPath.slice(0, -headingMatch[0].length);
  }

  return `${stripDocExtension(cleanPath)}${fragment}${relationSuffix}`;
}

export function canonicalizeSemanticReference(raw: string): string | null {
  const value = raw.trim();

  if (!value || value.includes("<") || value.includes(">")) return null;

  const taskLegacy = value.match(/^@task-([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)(\{[a-z-]+\})?$/);
  if (taskLegacy) {
    return `@task/${taskLegacy[1]}${taskLegacy[2] || ""}`;
  }

  if (/^@task\/[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?(?:\{[a-z-]+\})?$/.test(value)) {
    return value;
  }

  const memoryLegacy = value.match(/^@memory-([a-zA-Z0-9-]+)(\{[a-z-]+\})?$/);
  if (memoryLegacy) {
    return `@memory/${memoryLegacy[1]}${memoryLegacy[2] || ""}`;
  }

  if (/^@memory\/[a-zA-Z0-9-]+(?:\{[a-z-]+\})?$/.test(value)) {
    return value;
  }

  if (/^@decision\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\{[a-z-]+\})?$/.test(value)) {
    return value;
  }

  if (/^@template\/[a-zA-Z0-9_./-]+(?:\{[a-z-]+\})?$/.test(value)) {
    return value;
  }

  if (value.startsWith("@doc/") || value.startsWith("@docs/")) {
    return `@doc/${normalizeSemanticDocTarget(value)}`;
  }

  if (value.startsWith(".knowns/docs/") || value.startsWith("/.knowns/docs/")) {
    return `@doc/${normalizeSemanticDocTarget(value)}`;
  }

  return null;
}

export function encodeSemanticRefHref(raw: string): string {
  return `${SEMANTIC_LINK_PREFIX}${encodeURIComponent(raw)}`;
}

export function decodeSemanticRefHref(href: string): string | null {
  if (!href.startsWith(SEMANTIC_LINK_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(SEMANTIC_LINK_PREFIX.length));
  } catch {
    return null;
  }
}

function semanticMarkdownLink(raw: string): string {
  return `[${raw}](${encodeSemanticRefHref(raw)})`;
}

export function getInlineMention(raw: string): { type: "semantic"; rawRef: string } | null {
  const normalized = canonicalizeSemanticReference(raw);
  if (!normalized) return null;
  return { type: "semantic", rawRef: normalized };
}

export function transformMentions(content: string): string {
  const parts: string[] = [];
  let lastIndex = 0;

  const codeBlockRegex = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(transformMentionsInText(content.slice(lastIndex, match.index)));
    }
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(transformMentionsInText(content.slice(lastIndex)));
  }

  return parts.join("");
}

function transformMentionsInText(text: string): string {
  let transformed = normalizeKnownsTaskReferences(text);

  transformed = transformed.replace(TASK_MENTION_REGEX, (match, taskRef) => {
    const canonical = canonicalizeSemanticReference(`@${taskRef}`);
    return canonical ? semanticMarkdownLink(canonical) : match;
  });

  transformed = transformed.replace(MEMORY_MENTION_REGEX, (match, memoryRef) => {
    const canonical = canonicalizeSemanticReference(`@${memoryRef}`);
    return canonical ? semanticMarkdownLink(canonical) : match;
  });

  transformed = transformed.replace(DECISION_MENTION_REGEX, (match, decisionRef) => {
    const canonical = canonicalizeSemanticReference(`@${decisionRef}`);
    return canonical ? semanticMarkdownLink(canonical) : match;
  });

  transformed = transformed.replace(TEMPLATE_MENTION_REGEX, (match, templateRef) => {
    const canonical = canonicalizeSemanticReference(`@${templateRef}`);
    return canonical ? semanticMarkdownLink(canonical) : match;
  });

  transformed = transformed.replace(DOC_MENTION_REGEX, (match, docPath) => {
    const canonical = canonicalizeSemanticReference(`@doc/${docPath}`);
    return canonical ? semanticMarkdownLink(canonical) : match;
  });

  transformed = transformed.replace(KNOWNS_DOC_PATH_REGEX, (_match, prefix, docPath) => {
    const canonical = canonicalizeSemanticReference(docPath);
    return canonical ? `${prefix}${semanticMarkdownLink(canonical)}` : `${prefix}${docPath}`;
  });

  return transformed;
}

const mentionBase =
  "inline-flex items-center gap-1 px-1 py-px rounded text-[0.9em] font-medium cursor-pointer select-none transition-all no-underline";

export const taskMentionClass =
  `${mentionBase} bg-green-500/8 text-green-700 hover:bg-green-500/15 hover:underline decoration-green-500/40 dark:text-green-400`;

export const taskMentionBrokenClass =
  `${mentionBase} bg-red-500/8 text-red-600 line-through opacity-70 cursor-not-allowed dark:text-red-400`;

export const docMentionClass =
  `${mentionBase} bg-blue-500/8 text-blue-700 hover:bg-blue-500/15 hover:underline decoration-blue-500/40 dark:text-blue-400`;

export const docMentionBrokenClass =
  `${mentionBase} bg-red-500/8 text-red-600 line-through opacity-70 cursor-not-allowed dark:text-red-400`;

export const memoryMentionClass =
  `${mentionBase} bg-purple-500/8 text-purple-700 hover:bg-purple-500/15 hover:underline decoration-purple-500/40 dark:text-purple-400`;

export const decisionMentionClass =
  `${mentionBase} bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:underline decoration-amber-500/40 dark:text-amber-300`;

export const templateMentionClass =
  `${mentionBase} bg-cyan-500/10 text-cyan-700 hover:bg-cyan-500/20 hover:underline decoration-cyan-500/40 dark:text-cyan-300`;

export const semanticRelationClass =
  "ml-1 rounded-sm bg-black/5 px-1 py-0 text-[0.8em] font-semibold uppercase tracking-wide dark:bg-white/10";

export const semanticFragmentClass =
  "ml-1 rounded-sm border border-current/15 bg-current/5 px-1 py-0 text-[0.8em] font-medium tracking-normal opacity-80";

export const STATUS_STYLES: Record<string, string> = {
  todo: "bg-muted-foreground/50",
  "in-progress": "bg-yellow-500",
  "in-review": "bg-purple-500",
  blocked: "bg-red-500",
  done: "bg-green-500",
};
