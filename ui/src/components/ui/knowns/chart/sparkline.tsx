import { cn } from "@/ui/lib/knowns/utils";
import { areaPath, compact, isNum, linePath, seriesColor, sparkPoints, type ChartValue } from "./chart-utils";

export interface SparklineProps {
  values: ChartValue[];
  /** Name for screen readers, e.g. "Requests, last 14 days". The first and last value are appended. */
  label: string;
  /** Any CSS colour. Defaults to the first chart colour. */
  color?: string;
  /** Fill under the line. Default false. */
  area?: boolean;
  /** Dot on the last point. Default true. */
  endDot?: boolean;
  /** Smooth the line. Default false. */
  smooth?: boolean;
  /** Fill the container width instead of a fixed pixel width (the line is stretched, strokes stay crisp, no end dot). */
  fluid?: boolean;
  /** A faint line along the bottom. Default false. */
  baseline?: boolean;
  /** Box in px. The svg scales with its container width; keep h small. Defaults 96 x 28. Fluid sparklines use width only as the drawing grid. */
  width?: number;
  height?: number;
  className?: string;
}

/** A line with no axes, for stat tiles and table cells. Pure SVG, renders on the server. */
export function Sparkline({ values, label, color, area = false, endDot = true, smooth = false, fluid = false, baseline = false, width = 96, height = 28, className }: SparklineProps) {
  const vw = fluid ? 600 : width;
  const pts = sparkPoints(values, vw, height, fluid ? 1 : 3);
  const nums = values.filter(isNum);
  const c = color ?? seriesColor({ key: "", label: "" }, 0);
  const last = pts.length ? [...pts].reverse().find((p) => p.y !== null) : undefined;
  const desc = nums.length ? `${label}: from ${compact(nums[0])} to ${compact(nums[nums.length - 1])}` : `${label}: no data`;
  return (
    <svg role="img" aria-label={desc} viewBox={`0 0 ${vw} ${height}`} width={fluid ? "100%" : width} height={height} preserveAspectRatio={fluid ? "none" : undefined} className={cn("block max-w-full flex-none overflow-visible", className)} style={{ color: c }}>
      {baseline && <line x1={0} x2={vw} y1={height - 0.5} y2={height - 0.5} stroke="currentColor" strokeOpacity={0.18} vectorEffect="non-scaling-stroke" />}
      {pts.length > 0 && (
        <>
          {area && <path d={areaPath(pts, height, smooth)} fill="currentColor" opacity={0.12} />}
          <path d={linePath(pts, smooth)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {endDot && !fluid && last && last.y !== null && <circle cx={last.x} cy={last.y} r={2.25} fill="currentColor" />}
        </>
      )}
      {pts.length === 0 && <line x1={3} x2={vw - 3} y1={height / 2} y2={height / 2} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="2 3" />}
    </svg>
  );
}
