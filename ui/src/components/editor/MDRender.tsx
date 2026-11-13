import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useMemo,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check } from "lucide-react";
import { useTheme } from "../../App";
import { cn } from "../../lib/utils";

import {
  transformMentions,
  getInlineMention,
  decodeSemanticRefHref,
  canonicalizeSemanticReference,
} from "./mentionUtils";
import { SemanticReferenceBadge } from "./SemanticReferenceBadge";
import { MarkdownErrorBoundary } from "./MarkdownErrorBoundary";
import { parseHeadingMeta } from "./headingUtils";
import { CopyableTable, MarkdownCodeBlock, StableHeading, MermaidLoading } from "./mdComponents";

// Lazy load MermaidBlock for better performance
const MermaidBlock = lazy(() => import("./MermaidBlock"));

export interface MDRenderRef {
  getElement: () => HTMLElement | null;
}

interface MDRenderProps {
  markdown: string;
  className?: string;
  onDocLinkClick?: (path: string) => void;
  onTaskLinkClick?: (taskId: string) => void;
  showHeadingAnchors?: boolean;
  onHeadingAnchorClick?: (id: string) => void;
}

/**
 * Read-only markdown renderer with mention badge support
 */
const MDRender = forwardRef<MDRenderRef, MDRenderProps>(
  ({ markdown, className = "", onDocLinkClick, onTaskLinkClick, showHeadingAnchors = false, onHeadingAnchorClick }, ref) => {
    const { isDark } = useTheme();
    const containerRef = useRef<HTMLDivElement>(null);

    const transformedMarkdown = useMemo(() => transformMentions(markdown || ""), [markdown]);

    useImperativeHandle(ref, () => ({
      getElement: () => containerRef.current,
    }));

    const headingMeta = useMemo(() => parseHeadingMeta(markdown || ""), [markdown]);

    // Stable refs for callbacks and mutable state so components identity never changes
    const headingRenderIndexRef = useRef(0);
    const headingMetaRef = useRef(headingMeta);
    headingMetaRef.current = headingMeta;
    const showHeadingAnchorsRef = useRef(showHeadingAnchors);
    showHeadingAnchorsRef.current = showHeadingAnchors;
    const onHeadingAnchorClickRef = useRef(onHeadingAnchorClick);
    onHeadingAnchorClickRef.current = onHeadingAnchorClick;
    const onDocLinkClickRef = useRef(onDocLinkClick);
    onDocLinkClickRef.current = onDocLinkClick;
    const onTaskLinkClickRef = useRef(onTaskLinkClick);
    onTaskLinkClickRef.current = onTaskLinkClick;

    // Reset heading counter before each render of ReactMarkdown
    headingRenderIndexRef.current = 0;

    const components = useMemo(
      () => ({
        h2: ({ children, ...props }: { children?: ReactNode }) => (
          <StableHeading level={2} headingMetaRef={headingMetaRef} headingRenderIndexRef={headingRenderIndexRef} showHeadingAnchorsRef={showHeadingAnchorsRef} onHeadingAnchorClickRef={onHeadingAnchorClickRef} {...props}>{children}</StableHeading>
        ),
        h3: ({ children, ...props }: { children?: ReactNode }) => (
          <StableHeading level={3} headingMetaRef={headingMetaRef} headingRenderIndexRef={headingRenderIndexRef} showHeadingAnchorsRef={showHeadingAnchorsRef} onHeadingAnchorClickRef={onHeadingAnchorClickRef} {...props}>{children}</StableHeading>
        ),
        h4: ({ children, ...props }: { children?: ReactNode }) => (
          <StableHeading level={4} headingMetaRef={headingMetaRef} headingRenderIndexRef={headingRenderIndexRef} showHeadingAnchorsRef={showHeadingAnchorsRef} onHeadingAnchorClickRef={onHeadingAnchorClickRef} {...props}>{children}</StableHeading>
        ),

        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
          const text = String(children);
          const semanticRef = (href && decodeSemanticRefHref(href)) || canonicalizeSemanticReference(text) || (href ? canonicalizeSemanticReference(href) : null);

          if (semanticRef) {
            return (
              <SemanticReferenceBadge
                rawRef={semanticRef}
                onDocLinkClick={onDocLinkClickRef.current}
                onTaskLinkClick={onTaskLinkClickRef.current}
              />
            );
          }

          return <a href={href} className="text-primary hover:underline">{children}</a>;
        },

        code: ({
          className: codeClassName,
          children,
          node,
          ...props
        }: {
          className?: string;
          children?: ReactNode;
          node?: unknown;
        }) => {
          const match = /language-(\w+)/.exec(codeClassName || "");
          const language = match?.[1];
          const codeContent = String(children).replace(/\n$/, "");
          const isInline = !language && !String(children).includes("\n");

          if (isInline) {
            const inlineMention = getInlineMention(codeContent);
            if (inlineMention?.type === "semantic") {
              return (
                <SemanticReferenceBadge
                  rawRef={inlineMention.rawRef}
                  onDocLinkClick={onDocLinkClickRef.current}
                  onTaskLinkClick={onTaskLinkClickRef.current}
                />
              );
            }
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm whitespace-break-spaces break-words [overflow-wrap:anywhere]" {...props}>
                {children}
              </code>
            );
          }

          if (language === "mermaid") {
            const key = `mermaid-${codeContent.length}-${codeContent.slice(0, 50).replace(/\s/g, '')}`;
            return (
              <Suspense key={key} fallback={<MermaidLoading />}>
                <MermaidBlock code={codeContent} />
              </Suspense>
            );
          }

          return <MarkdownCodeBlock code={codeContent} language={language} />;
        },

        // Fenced code is drawn by the Knowns UI code block (its own frame, copy and wrap) and
        // Mermaid by its own viewer, so the markdown <pre> around them adds nothing.
        pre: ({ children }: { children?: ReactNode }) => <>{children}</>,

        input: ({ type, checked, disabled, ...props }: { type?: string; checked?: boolean; disabled?: boolean }) => {
          if (type === "checkbox") {
            return (
              <span
                className={cn(
                  "inline-flex items-center justify-center h-4 w-4 shrink-0 rounded-sm border mr-2 align-text-bottom",
                  checked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50"
                )}
                aria-checked={checked}
                role="checkbox"
              >
                {checked && <Check className="h-3 w-3" />}
              </span>
            );
          }
          return <input type={type} checked={checked} disabled={disabled} {...props} />;
        },

        li: ({ children, className, ...props }: { children?: ReactNode; className?: string }) => {
          const isTaskListItem = className?.includes("task-list-item");
          return (
            <li className={cn(className, isTaskListItem && "list-none ml-0 flex items-start gap-0")} {...props}>
              {children}
            </li>
          );
        },

        ul: ({ children, className, ...props }: { children?: ReactNode; className?: string }) => {
          const isTaskList = className?.includes("contains-task-list");
          return (
            <ul className={cn(className, isTaskList && "list-none pl-0")} {...props}>
              {children}
            </ul>
          );
        },

        table: CopyableTable,

        thead: ({ children, ...props }: { children?: ReactNode }) => (
          <thead className="bg-muted" {...props}>{children}</thead>
        ),
        tbody: ({ children, ...props }: { children?: ReactNode }) => (
          <tbody className="divide-y divide-border/50" {...props}>{children}</tbody>
        ),
        tr: ({ children, ...props }: { children?: ReactNode }) => (
          <tr className="hover:bg-muted/50 transition-colors" {...props}>{children}</tr>
        ),
        th: ({ children, ...props }: { children?: ReactNode }) => (
          <th className="px-4 py-3 text-left font-semibold border-b-2 border-border" {...props}>{children}</th>
        ),
        td: ({ children, ...props }: { children?: ReactNode }) => (
          <td className="px-4 py-3 border-b border-border/30" {...props}>{children}</td>
        ),
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- all changing values accessed via stable refs
      []
    );

    if (!markdown) return null;

    return (
      <div
        ref={containerRef}
        className={`md-render-wrapper ${className}`}
        data-color-mode={isDark ? "dark" : "light"}
      >
        <MarkdownErrorBoundary>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {transformedMarkdown}
          </ReactMarkdown>
        </MarkdownErrorBoundary>
      </div>
    );
  },
);

MDRender.displayName = "MDRender";

export default MDRender;
