import { useState, useRef, type ReactNode } from "react";
import { ClipboardCheck, Check, Loader2 } from "lucide-react";
import hljs from "highlight.js";
import { CodeBlock } from "@/ui/components/ui/knowns/code-block/code-block";
import { resolveLanguage, tokenize, type CodeLines } from "@/ui/components/ui/knowns/code-block/code-block-utils";
import { extractTextFromChildren, slugifyHeading, type HeadingMeta } from "./headingUtils";
import { hljsHtmlToLines } from "./hljsTokens";

/**
 * The Knowns UI tokenizer for the languages it knows (so code reads the same as everywhere else in
 * the app), highlight.js mapped onto the same token colours for the rest.
 */
function highlightCode(code: string, language: string | undefined): CodeLines {
  if (resolveLanguage(language)) return tokenize(code, language);
  try {
    const html = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value;
    return hljsHtmlToLines(html);
  } catch {
    return tokenize(code, undefined);
  }
}

/** A fenced code block in rendered markdown: language label, copy, wrap, and a fold past 30 lines. */
export function MarkdownCodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <CodeBlock
      code={code}
      language={language}
      highlight={highlightCode}
      collapseAfter={30}
      className="my-4"
      aria-label={language ? `${language} code` : "Code"}
    />
  );
}

/** Copyable table wrapper with markdown export. */
export function CopyableTable({ children, ...props }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);

  const handleCopyTable = () => {
    if (!tableRef.current) return;
    const rows = tableRef.current.querySelectorAll("tr");
    const markdownRows: string[] = [];
    rows.forEach((row, rowIndex) => {
      const cells = row.querySelectorAll("th, td");
      const cellTexts = Array.from(cells).map((cell) => cell.textContent?.trim() || "");
      markdownRows.push(`| ${cellTexts.join(" | ")} |`);
      if (rowIndex === 0) {
        markdownRows.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
      }
    });
    navigator.clipboard.writeText(markdownRows.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="table-wrapper group relative my-4 overflow-x-auto rounded-lg border border-border">
      <button
        type="button"
        onClick={handleCopyTable}
        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-(--kn-dur-fast) ease-(--kn-ease-out) p-1.5 rounded-md bg-muted hover:bg-muted/80 border border-border text-muted-foreground hover:text-foreground"
        title="Copy as Markdown"
      >
        {copied ? <Check className="w-4 h-4 text-green-500" /> : <ClipboardCheck className="w-4 h-4" />}
      </button>
      <table ref={tableRef} className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  );
}

/** Heading with stable identity — reads mutable state via refs. */
export function StableHeading({
  level,
  children,
  headingMetaRef,
  headingRenderIndexRef,
  showHeadingAnchorsRef,
  onHeadingAnchorClickRef,
  ...props
}: {
  level: number;
  children?: ReactNode;
  headingMetaRef: React.RefObject<HeadingMeta[]>;
  headingRenderIndexRef: React.MutableRefObject<number>;
  showHeadingAnchorsRef: React.RefObject<boolean>;
  onHeadingAnchorClickRef: React.RefObject<((id: string) => void) | undefined>;
}) {
  const Tag = `h${level}` as "h2" | "h3" | "h4";
  if (!showHeadingAnchorsRef.current) {
    return <Tag {...props}>{children}</Tag>;
  }

  const text = extractTextFromChildren(children);
  const meta = headingMetaRef.current[headingRenderIndexRef.current];
  headingRenderIndexRef.current += 1;

  const number = meta?.number ?? "";
  const id = meta?.id ?? slugifyHeading(text);

  const headingClassName =
    level <= 3
      ? "group relative scroll-mt-4 flex items-baseline gap-2"
      : "group relative scroll-mt-4 flex items-baseline gap-1.5";

  return (
    <Tag id={id} data-heading-slug={slugifyHeading(text)} className={headingClassName} {...props}>
      {number && (
        <span className="inline-block text-[0.72em] font-semibold text-muted-foreground/50 select-none leading-none translate-y-[1px]">
          {number}
        </span>
      )}
      <span className="min-w-0">{children}</span>
      <a
        href={`#${id}`}
        className="ml-1 text-muted-foreground/0 group-hover:text-muted-foreground/50 hover:!text-foreground transition-colors no-underline leading-none"
        aria-label={`Link to section ${number}${text ? ` ${text}` : ""}`}
        onClick={(e) => {
          if (onHeadingAnchorClickRef.current) {
            e.preventDefault();
            onHeadingAnchorClickRef.current(id);
          }
        }}
      >
        #
      </a>
    </Tag>
  );
}

/** Mermaid diagram loading placeholder. */
export function MermaidLoading() {
  return (
    <div className="my-4 p-4 rounded-lg border bg-muted/30 animate-pulse">
      <div className="h-32 flex items-center justify-center text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading diagram...
      </div>
    </div>
  );
}
