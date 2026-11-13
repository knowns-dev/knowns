"use client";
/** @registry name="code-block" type="ui" title="Code Block" description="Code with syntax colours, a copy button, filename and language label, line numbers, highlighted lines, a wrap toggle and long-output collapse. No highlighter dependency, and a slot for Shiki." */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn, focusRing, writeClipboard } from "@/ui/lib/knowns/utils";
import { Fold, MotionStyle } from "@/ui/lib/knowns/motion";
import { TOKEN_CLASS, gutterWidth, languageLabel, parseLineSpec, tokenize, trimCode, visibleCount, type CodeLines } from "./code-block-utils";

export type { CodeLines, CodeToken, TokenKind } from "./code-block-utils";

export interface CodeBlockProps {
  /** The code, as a string. Leading blank lines and trailing whitespace are trimmed (`trim={false}` keeps them). */
  code: string;
  /** `tsx`, `ts`, `js`, `json`, `bash`, `css`, `html`, `python`, `yaml`, `diff`, or any name (shown as typed, not coloured). */
  language?: string;
  /** A file name for the header, e.g. `app/page.tsx`. */
  filename?: string;
  /** Left gutter with line numbers. Not copied and not read out. */
  lineNumbers?: boolean;
  /** Lines to mark: `3`, `[1, 4]` or `"1,3-5"` (`"8-"` runs to the end). 1-based. */
  highlightLines?: number | number[] | string;
  /** Soft-wrap long lines. Pass it for a controlled block, or use `defaultWrap` and the toggle. */
  wrap?: boolean;
  defaultWrap?: boolean;
  /** Called when the wrap toggle is pressed. */
  onWrapChange?: (wrap: boolean) => void;
  /** Show the wrap toggle. Default true. */
  wrapToggle?: boolean;
  /** Fold anything longer than this many lines behind "Show N more lines". Off by default. */
  collapseAfter?: number;
  /** Start unfolded when `collapseAfter` is set. */
  defaultExpanded?: boolean;
  /** Open and close the "Show N more lines" fold with a height transition instead of swapping the lines. Default false. */
  animateFold?: boolean;
  /** Show the copy button. Default true. */
  copy?: boolean;
  /** Called after the code is copied. */
  onCopy?: (code: string) => void;
  /** Use your own highlighter (e.g. Shiki): code and language in, tokens per line out. Default is the built-in tokenizer. */
  highlight?: (code: string, language: string | undefined) => CodeLines;
  /** Trim leading blank lines and trailing whitespace. Default true. */
  trim?: boolean;
  /** Shown before the filename in the header, e.g. a file icon. */
  icon?: ReactNode;
  /** Header text in place of the language name, e.g. "Output, 42 lines". */
  label?: ReactNode;
  /** No frame, background or rounding, for a block nested inside another card. */
  flush?: boolean;
  /** Cap the code region at this height (px or any CSS length) and scroll inside it. */
  maxHeight?: number | string;
  /** With `maxHeight`: keep the end of the code in view as it grows (streaming output), until the reader scrolls up. */
  follow?: boolean;
  className?: string;
  /** Name for the scrollable code region when there is no filename. Default: the language, else "Code". */
  "aria-label"?: string;
}

const svg = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const CopyIcon = () => (
  <svg {...svg}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.75" />
    <path d="M10.75 5.25V4A1.75 1.75 0 0 0 9 2.25H4A1.75 1.75 0 0 0 2.25 4v5A1.75 1.75 0 0 0 4 10.75h1.25" />
  </svg>
);
const CheckIcon = () => (
  <svg {...svg}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);
const WrapIcon = () => (
  <svg {...svg}>
    <path d="M2.5 4h11M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H8.5m0 0 1.5-1.5M8.5 12.5 10 14M2.5 12h2.5" />
  </svg>
);

const toolbar = cn(
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-medium text-muted-foreground transition-colors duration-200",
  "hover:bg-foreground/[0.06] hover:text-foreground aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground pointer-coarse:h-9 [&_svg]:size-3.5",
  focusRing,
);

/**
 * A block of code: syntax colours from a built-in tokenizer (no dependency, the same in RSC, the browser and a Worker),
 * a copy button, filename and language, line numbers, highlighted lines, a wrap toggle and a fold for long output.
 * The code region scrolls and takes focus, so long lines are reachable by keyboard.
 */
export function CodeBlock({
  code,
  language,
  filename,
  lineNumbers = false,
  highlightLines,
  wrap,
  defaultWrap = false,
  onWrapChange,
  wrapToggle = true,
  collapseAfter,
  defaultExpanded = false,
  animateFold = false,
  copy = true,
  onCopy,
  highlight,
  trim = true,
  icon,
  label: labelProp,
  flush = false,
  maxHeight,
  follow = false,
  className,
  "aria-label": ariaLabel,
}: CodeBlockProps) {
  const text = trim ? trimCode(code) : code;
  const lines = useMemo(() => (highlight ?? tokenize)(text, language), [highlight, text, language]);
  const total = lines.length;
  const marked = useMemo(() => parseLineSpec(highlightLines, total), [highlightLines, total]);

  const [ownWrap, setOwnWrap] = useState(defaultWrap);
  const wrapped = wrap ?? ownWrap;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { shown, hidden, collapsible } = visibleCount(total, collapseAfter, expanded);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const bodyId = useId();

  const label = labelProp ?? languageLabel(language);
  const region = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // Streaming: stay on the last line while the code grows, unless the reader has scrolled up.
  useEffect(() => {
    const el = region.current;
    if (follow && el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [follow, text, shown]);
  const gutter = gutterWidth(total);
  const hasHeader = Boolean(filename || label || copy || wrapToggle);
  const regionName = ariaLabel ?? (filename ? `${filename}, code` : typeof label === "string" ? `${label} code` : "Code");

  const doCopy = async () => {
    try {
      await writeClipboard(text);
    } catch {
      return;
    }
    onCopy?.(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  const renderLine = (tokens: CodeLines[number], i: number) => {
    const n = i + 1;
    const on = marked.has(n);
    return (
      <span
        key={i}
        data-line={n}
        data-highlighted={on ? "" : undefined}
        className={cn("grid min-h-[1.7em] px-3.5", lineNumbers ? "grid-cols-[var(--g)_1fr]" : "grid-cols-1", on && "bg-foreground/[0.05] dark:bg-foreground/[0.08] shadow-[inset_2px_0_0_var(--foreground)]")}
        style={lineNumbers ? ({ "--g": `${gutter}ch` } as CSSProperties) : undefined}
      >
        {lineNumbers && (
          <span aria-hidden className="pr-3 text-right text-muted-foreground/80 tabular-nums select-none">
            {n}
          </span>
        )}
        <span className={cn("min-w-0", wrapped ? "break-words whitespace-pre-wrap" : "whitespace-pre")}>
          {on && <span className="sr-only">Highlighted: </span>}
          {tokens.length === 0
            ? "\u200b"
            : tokens.map((t, k) =>
                t.color ? (
                  <span key={k} className="text-(--kn-tc) dark:text-(--kn-td)" style={{ "--kn-tc": t.color, "--kn-td": t.darkColor ?? t.color } as CSSProperties}>
                    {t.text}
                  </span>
                ) : t.kind === "plain" ? (
                  t.text
                ) : t.kind === "inserted" || t.kind === "deleted" ? (
                  <span key={k} className={t.kind === "inserted" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
                    {t.text}
                  </span>
                ) : (
                  <span key={k} className={TOKEN_CLASS[t.kind]}>
                    {t.text}
                  </span>
                ),
              )}
        </span>
      </span>
    );
  };

  return (
    <figure data-slot="code-block" className={cn("m-0 min-w-0 overflow-hidden text-foreground", !flush && "rounded-[12px] border border-border bg-muted/50 dark:bg-muted/30", className)}>
      {animateFold && <MotionStyle />}
      {hasHeader && (
        <figcaption className={cn("flex items-center gap-2 py-1 pr-1.5", flush ? "min-h-8 pl-3.5" : "min-h-10 border-b border-border pl-3.5")}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {icon && <span className="flex-none text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
            {filename && <span className="truncate font-mono text-[12.5px] text-foreground">{filename}</span>}
            {label && <span className={cn("flex-none text-[12px] text-muted-foreground", filename && "before:mr-2 before:text-border before:content-['/']")}>{label}</span>}
          </div>
          <div className="flex flex-none items-center gap-0.5">
            {wrapToggle && (
              <button
                type="button"
                aria-pressed={wrapped}
                aria-label="Wrap lines"
                title="Wrap lines"
                onClick={() => {
                  if (wrap === undefined) setOwnWrap(!wrapped);
                  onWrapChange?.(!wrapped);
                }}
                className={toolbar}
              >
                <WrapIcon />
                <span className="hidden sm:inline">Wrap</span>
              </button>
            )}
            {copy && (
              <button type="button" onClick={doCopy} aria-label={copied ? "Copied to clipboard" : "Copy code"} className={toolbar}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span className="min-w-[2.9rem] text-left">{copied ? "Copied" : "Copy"}</span>
              </button>
            )}
          </div>
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? "Code copied to clipboard" : ""}
          </span>
        </figcaption>
      )}
      <div
        id={bodyId}
        ref={region}
        onScroll={follow ? (e) => (stuck.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24) : undefined}
        style={maxHeight === undefined ? undefined : { maxHeight }}
        role="region"
        aria-label={regionName}
        tabIndex={0}
        className={cn("overflow-x-auto focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", wrapped && "overflow-x-hidden", maxHeight !== undefined && "overflow-y-auto")}
      >
        <pre className={cn("m-0 py-3 font-mono text-[12.5px] leading-[1.7] text-foreground", wrapped ? "w-full" : "w-max min-w-full")}>
          <code className="block">
            {animateFold && collapsible ? (
              <>
                {lines.slice(0, collapseAfter).map((tokens, i) => renderLine(tokens, i))}
                <Fold as="span" open={expanded}>
                  {lines.slice(collapseAfter).map((tokens, i) => renderLine(tokens, i + (collapseAfter ?? 0)))}
                </Fold>
              </>
            ) : (
              lines.slice(0, shown).map((tokens, i) => renderLine(tokens, i))
            )}
          </code>
        </pre>
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
          className={cn("flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 border-t border-border text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground", focusRing, "focus-visible:-outline-offset-2")}
        >
          {expanded ? "Show less" : `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`}
          <svg {...svg} className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-180")}>
            <path d="m4 6.25 4 4 4-4" />
          </svg>
        </button>
      )}
    </figure>
  );
}
