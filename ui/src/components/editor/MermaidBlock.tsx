import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  X,
  Copy,
  Check,
} from "lucide-react";
import { useTheme } from "../../App";

interface MermaidBlockProps {
  code: string;
}

let mermaidInitialized = false;
let currentTheme: "dark" | "default" = "default";

function getRenderedMermaidError(rendered: string): string | null {
  if (!rendered) return null;
  if (
    rendered.includes('class="error-text"') ||
    rendered.includes("Syntax error in text") ||
    (rendered.toLowerCase().includes("mermaid version") && rendered.toLowerCase().includes("error"))
  ) {
    return "Syntax error in Mermaid diagram";
  }
  return null;
}

function initMermaid(isDark: boolean) {
  const theme = isDark ? "dark" : "default";
  if (mermaidInitialized && currentTheme === theme) return;

  mermaid.initialize({
    startOnLoad: false,
    theme: theme,
    securityLevel: "loose",
    fontFamily:
      '"Geist Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    themeVariables: isDark
      ? {
          primaryColor: "#3d4144",
          primaryTextColor: "#c9d1d9",
          primaryBorderColor: "#6e7681",
          lineColor: "#8b949e",
          secondaryColor: "#21262d",
          tertiaryColor: "#161b22",
          background: "#0d1117",
          mainBkg: "#0d1117",
          nodeBorder: "#6e7681",
          clusterBkg: "#21262d",
          titleColor: "#c9d1d9",
          edgeLabelBackground: "#0d1117",
        }
      : {},
  });
  mermaidInitialized = true;
  currentTheme = theme;
}

const ZOOM_STEP = 0.15;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 5;

// Button component for controls
function ControlButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className="p-2 rounded-md bg-muted/90 hover:bg-muted border border-border transition-colors disabled:opacity-40 backdrop-blur-sm"
      title={title}
    >
      {children}
    </button>
  );
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.5);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });

  // Fit diagram to container
  const fitToView = useCallback(() => {
    const container = containerRef.current;
    const diagramEl = diagramRef.current;
    if (!container || !diagramEl) return;
    const svgEl = diagramEl.querySelector("svg");
    if (!svgEl) return;

    // Get intrinsic SVG size from viewBox, attributes, or style
    let svgW = 0;
    let svgH = 0;
    const viewBox = svgEl.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        svgW = parts[2];
        svgH = parts[3];
      }
    }
    if (!svgW || !svgH) {
      const wAttr = svgEl.getAttribute("width");
      const hAttr = svgEl.getAttribute("height");
      if (wAttr) svgW = parseFloat(wAttr);
      if (hAttr) svgH = parseFloat(hAttr);
    }
    if (!svgW || !svgH) {
      // Remove transform temporarily to measure natural size
      const prevTransform = diagramEl.style.transform;
      diagramEl.style.transform = "none";
      const rect = svgEl.getBoundingClientRect();
      svgW = rect.width;
      svgH = rect.height;
      diagramEl.style.transform = prevTransform;
    }
    if (!svgW || !svgH) return;

    const containerRect = container.getBoundingClientRect();
    const padding = 40;
    const scaleX = (containerRect.width - padding) / svgW;
    const scaleY = (containerRect.height - padding) / svgH;
    // Scale to fit, cap at 150% so small diagrams don't get too blown up
    const fitZoom = Math.min(scaleX, scaleY);
    const newZoom = Math.max(MIN_ZOOM, Math.min(1.5, fitZoom));
    setZoom(newZoom);
    setPosition({ x: 0, y: 0 });
  }, []);

  // Handlers
  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM)), []);
  const handleReset = fitToView;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  // Mouse drag to pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    posStartRef.current = { ...position };
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      setPosition({
        x: posStartRef.current.x + (e.clientX - dragStartRef.current.x),
        y: posStartRef.current.y + (e.clientY - dragStartRef.current.y),
      });
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  // Ctrl/Cmd + Wheel zoom (centered on cursor)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setZoom((prevZoom) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZoom + delta));
        const scale = newZoom / prevZoom;
        setPosition((p) => ({
          x: cx - scale * (cx - p.x),
          y: cy - scale * (cy - p.y),
        }));
        return newZoom;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svg, isFullscreen]);

  // ESC to close fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  // Render mermaid
  useEffect(() => {
    if (!code) return;
    initMermaid(isDark);
    let cancelled = false;

    (async () => {
      try {
        await mermaid.parse(code.trim(), { suppressErrors: false });
        const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`;
        const { svg: rendered } = await mermaid.render(id, code.trim());
        const renderError = getRenderedMermaidError(rendered);
        if (cancelled) return;
        if (renderError) {
          setError(renderError);
          setSvg(null);
          return;
        }
        setSvg(rendered);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to render Mermaid diagram");
        setSvg(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  const [containerRatio, setContainerRatio] = useState("16 / 9");

  // Adjust container aspect ratio after render (but don't auto-fit zoom — keep default 150%)
  useEffect(() => {
    if (!svg) return;
    requestAnimationFrame(() => {
      const diagramEl = diagramRef.current;
      if (diagramEl) {
        const svgEl = diagramEl.querySelector("svg");
        if (svgEl) {
          let svgW = 0, svgH = 0;
          const viewBox = svgEl.getAttribute("viewBox");
          if (viewBox) {
            const parts = viewBox.split(/[\s,]+/).map(Number);
            if (parts.length === 4) { svgW = parts[2]; svgH = parts[3]; }
          }
          if (!svgW || !svgH) {
            const wAttr = svgEl.getAttribute("width");
            const hAttr = svgEl.getAttribute("height");
            if (wAttr) svgW = parseFloat(wAttr);
            if (hAttr) svgH = parseFloat(hAttr);
          }
          if (svgW && svgH) {
            const ratio = svgW / svgH;
            const clamped = Math.max(4 / 3, Math.min(21 / 9, ratio));
            setContainerRatio(`${clamped}`);
          }
        }
      }
    });
  }, [svg]);

  if (error) {
    return (
      <div className="my-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <div className="text-sm font-medium text-amber-700 dark:text-amber-300">Invalid Mermaid diagram</div>
        <div className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/80">{error}</div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 p-4 rounded-lg border bg-muted animate-pulse">
        <div className="h-32 flex items-center justify-center text-muted-foreground">Loading diagram...</div>
      </div>
    );
  }

  const zoomPercent = Math.round(zoom * 100);

  // Controls overlay
  const controls = (
    <>
      {/* Top-right: Fullscreen + Copy */}
      <div className="absolute top-3 right-3 flex gap-1 z-20">
        {!isFullscreen && (
          <ControlButton onClick={() => setIsFullscreen(true)} title="Fullscreen">
            <Maximize2 className="w-4 h-4 text-muted-foreground" />
          </ControlButton>
        )}
        {isFullscreen && (
          <ControlButton onClick={() => setIsFullscreen(false)} title="Close">
            <X className="w-4 h-4 text-muted-foreground" />
          </ControlButton>
        )}
        <ControlButton onClick={handleCopy} title="Copy code">
          {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
        </ControlButton>
      </div>

      {/* Bottom-right: Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 z-20">
        <ControlButton onClick={handleZoomOut} disabled={zoom <= MIN_ZOOM} title="Zoom out">
          <ZoomOut className="w-4 h-4 text-muted-foreground" />
        </ControlButton>
        <span className="text-xs text-muted-foreground bg-muted/90 px-2 py-1.5 rounded-md border border-border backdrop-blur-sm min-w-[3rem] text-center select-none">
          {zoomPercent}%
        </span>
        <ControlButton onClick={handleZoomIn} disabled={zoom >= MAX_ZOOM} title="Zoom in">
          <ZoomIn className="w-4 h-4 text-muted-foreground" />
        </ControlButton>
        <ControlButton onClick={handleReset} title="Reset view">
          <RotateCcw className="w-4 h-4 text-muted-foreground" />
        </ControlButton>
      </div>
    </>
  );

  // Diagram element
  const diagram = (
    <div
      ref={diagramRef}
      className="mermaid-diagram [&_svg]:max-w-none select-none"
      style={{
        transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
        transformOrigin: "center center",
        transition: isDragging ? "none" : "transform 0.15s ease-out",
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );

  const cursorStyle = isDragging ? "cursor-grabbing" : "cursor-grab";

  // Fullscreen modal via portal
  if (isFullscreen) {
    return createPortal(
      <div
        className="fixed inset-0 bg-background flex items-center justify-center"
        style={{ zIndex: 99999 }}
        onClick={(e) => e.target === e.currentTarget && setIsFullscreen(false)}
      >
        <div
          ref={containerRef}
          className={`relative w-full h-full flex items-center justify-center overflow-hidden ${cursorStyle}`}
          onMouseDown={handleMouseDown}
        >
          {diagram}
          {controls}
          <div className="absolute top-3 left-3 text-xs text-muted-foreground bg-muted/90 px-2 py-1 rounded border border-border z-20">
            Ctrl+Scroll to zoom · Drag to pan · ESC to close
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Normal inline view
  return (
    <div className="mermaid-wrapper my-4 rounded-lg border overflow-hidden relative">
      <div
        ref={containerRef}
        className={`mermaid-container bg-muted/30 overflow-hidden flex items-center justify-center ${cursorStyle}`}
        style={{ aspectRatio: containerRatio }}
        onMouseDown={handleMouseDown}
      >
        {diagram}
      </div>
      {controls}
    </div>
  );
}

export default MermaidBlock;
