import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { useTheme } from "../../App";

interface MermaidBlockProps {
  code: string;
}

// Initialize mermaid with default config
let mermaidInitialized = false;

function initMermaid(isDark: boolean) {
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "default",
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

/**
 * Mermaid diagram renderer component
 * Renders mermaid code blocks as SVG diagrams
 */
export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const { isDark } = useTheme();

  useEffect(() => {
    if (!code || !containerRef.current) return;

    // Re-initialize mermaid when theme changes
    initMermaid(isDark);

    const renderDiagram = async () => {
      try {
        // Generate unique ID for this diagram
        const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`;

        // Render the diagram
        const { svg: renderedSvg } = await mermaid.render(id, code.trim());
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        console.error("Mermaid render error:", err);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setSvg(null);
      }
    };

    renderDiagram();
  }, [code, isDark]);

  if (error) {
    return (
      <div className="my-4 p-4 rounded-lg border border-red-500/30 bg-red-500/10">
        <div className="text-sm text-red-600 dark:text-red-400 mb-2">
          Mermaid Error: {error}
        </div>
        <pre className="text-xs overflow-auto p-2 bg-muted rounded">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (svg) {
    return (
      <div
        ref={containerRef}
        className="my-4 p-4 rounded-lg border bg-card overflow-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Loading state
  return (
    <div
      ref={containerRef}
      className="my-4 p-4 rounded-lg border bg-card animate-pulse"
    >
      <div className="h-32 flex items-center justify-center text-muted-foreground">
        Loading diagram...
      </div>
    </div>
  );
}

export default MermaidBlock;
