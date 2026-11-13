"use client";
/** @registry name="empty-states" type="ui" title="Empty states" description="Quiet animated scenes for no runs, an empty inbox, no tools and no agents, with title, description and action." */

import { useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { AGENT_PALETTE } from "@/ui/lib/knowns/status";
import { MOTION_GATE, useLive } from "./use-in-view";

export interface EmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** A button or link under the text. */
  action?: ReactNode;
  /** Smaller art and text, for panels and cards. */
  compact?: boolean;
  paused?: boolean;
  className?: string;
}

/* ── One visual language for every scene ──
 * A 160 x 100 drawing in the text colour at a few fixed opacities, 1.25px solid hairlines, 4-6px radii,
 * soft neutral fills, exactly one accent detail and one quiet loop per scene. The same language as the
 * catalog thumbnails, so the site reads as one family. Reduced motion (and offscreen) shows the still frame. */
const ACCENT = AGENT_PALETTE[0];
const INK = { fill: 0.06, fillStrong: 0.1, line: 0.32, faint: 0.18, text: 0.22, strong: 0.62 } as const;

const CSS = `
@keyframes knes-caret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes knes-breathe { 0%, 100% { transform: scale(1); opacity: .9 } 50% { transform: scale(1.06); opacity: 1 } }
@keyframes knes-ease { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(5px) } }
@keyframes knes-orbit { to { offset-distance: 100% } }
@keyframes knes-scan { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(10px) } }
${MOTION_GATE}
`;

const center: CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };

function Box({ x, y, w, h, r = 5, strong, fill = true }: { x: number; y: number; w: number; h: number; r?: number; strong?: boolean; fill?: boolean }) {
  return (
    <rect
      x={x + 0.5}
      y={y + 0.5}
      width={w - 1}
      height={h - 1}
      rx={r}
      fill="currentColor"
      fillOpacity={fill ? (strong ? INK.fillStrong : INK.fill) : 0}
      stroke="currentColor"
      strokeOpacity={strong ? INK.strong : INK.line}
      strokeWidth={1.25}
    />
  );
}
const Text = ({ x, y, w, strong }: { x: number; y: number; w: number; strong?: boolean }) => <rect x={x} y={y - 2} width={w} height={4} rx={2} fill="currentColor" fillOpacity={strong ? INK.strong * 0.7 : INK.text} />;
const Line = ({ d, faint }: { d: string; faint?: boolean }) => <path d={d} fill="none" stroke="currentColor" strokeOpacity={faint ? INK.faint : INK.line} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />;
const Ring = ({ x, y, r }: { x: number; y: number; r: number }) => <circle cx={x} cy={y} r={r} fill="currentColor" fillOpacity={INK.fill} stroke="currentColor" strokeOpacity={INK.line} strokeWidth={1.25} />;

function Frame({ name, art, title, description, action, compact, paused, className, label }: EmptyStateProps & { name: string; art: ReactNode; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const { live } = useLive(root, paused);
  return (
    <div ref={root} data-kn-ill={name} data-live={live} className={cn("flex flex-col items-center text-center", compact ? "py-5" : "py-10", className)}>
      <style href="kn-empty-states" precedence="default">
        {CSS}
      </style>
      <svg viewBox="0 0 160 100" role="img" aria-label={label} className={cn("block text-foreground", compact ? "h-[72px] w-[115px]" : "h-28 w-[180px]")}>
        {art}
      </svg>
      {title && <p className={cn("font-semibold text-foreground", compact ? "mt-3 text-[14px]" : "mt-4 text-[16px]")}>{title}</p>}
      {description && <p className={cn("max-w-[32ch] text-balance text-muted-foreground", compact ? "mt-1 text-[13px]" : "mt-2 text-[14px] leading-relaxed")}>{description}</p>}
      {action && <div className={compact ? "mt-3" : "mt-4"}>{action}</div>}
    </div>
  );
}

/** No runs yet: an agent graph with empty seats and a prompt waiting, its caret blinking. */
export function NoRuns({ title = "No runs yet", description = "Send a first prompt and your agents show up here as they work.", ...rest }: EmptyStateProps) {
  return (
    <Frame
      name="no-runs"
      label="An empty agent graph waiting for a first prompt"
      title={title}
      description={description}
      {...rest}
      art={
        <>
          <Line d="M80 30V22H44V14M80 22H116V14" />
          <Box x={68} y={30} w={24} h={18} strong />
          <Box x={34} y={4} w={20} h={12} r={4} fill={false} />
          <Box x={106} y={4} w={20} h={12} r={4} fill={false} />
          <Line d="M80 48V58" faint />
          {/* The prompt. */}
          <Box x={30} y={62} w={100} h={22} r={6} />
          <Text x={40} y={73} w={36} />
          <rect x={80} y={67} width={1.75} height={12} rx={0.9} fill={ACCENT} style={{ animation: "knes-caret 1.1s steps(1) infinite" }} />
          <rect x={112} y={67} width={12} height={12} rx={4} fill="currentColor" fillOpacity={INK.fillStrong} />
        </>
      }
    />
  );
}

/** All caught up: an approvals list with every row cleared and one check. */
export function EmptyInbox({ title = "You're all caught up", description = "No approvals waiting. Agents ask here before anything risky.", ...rest }: EmptyStateProps) {
  return (
    <Frame
      name="empty-inbox"
      label="An approvals list with nothing waiting"
      title={title}
      description={description}
      {...rest}
      art={
        <>
          <Box x={34} y={10} w={92} h={80} r={6} />
          <Text x={44} y={22} w={34} strong />
          <Line d="M34 30H126" faint />
          {[42, 56, 70].map((y) => (
            <g key={y}>
              <rect x={44} y={y - 4} width={8} height={8} rx={2.5} fill="currentColor" fillOpacity={INK.fill} stroke="currentColor" strokeOpacity={INK.faint} strokeWidth={1.25} />
              <Text x={58} y={y} w={y === 56 ? 40 : 52} />
            </g>
          ))}
          <g style={{ ...center, animation: "knes-breathe 3.6s ease-in-out infinite" }}>
            <circle cx={118} cy={80} r={11} fill="var(--card, #fff)" stroke={ACCENT} strokeWidth={1.5} />
            <path d="M113.5 80.2l3 3 6-6.4" fill="none" stroke={ACCENT} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </>
      }
    />
  );
}

/** No tools connected: a plug easing toward its socket, one accent pin. */
export function NoTools({ title = "No tools connected", description = "Connect a tool so your agents can search, read and act.", ...rest }: EmptyStateProps) {
  return (
    <Frame
      name="no-tools"
      label="An unplugged connector"
      title={title}
      description={description}
      {...rest}
      art={
        <>
          <g style={{ animation: "knes-ease 2.8s cubic-bezier(.22,1,.36,1) infinite" }}>
            <Line d="M10 62H34Q42 62 42 54V50" />
            <Box x={34} y={36} w={26} h={20} r={5} strong />
            <Line d="M60 42H68M60 50H68" />
          </g>
          <Box x={88} y={34} w={30} h={24} r={6} />
          <rect x={95} y={41} width={6} height={3} rx={1.5} fill="currentColor" fillOpacity={INK.strong * 0.6} />
          <rect x={95} y={48} width={6} height={3} rx={1.5} fill={ACCENT} />
          <Line d="M118 46H128Q136 46 136 38V20H150" />
          <Text x={56} y={82} w={48} />
        </>
      }
    />
  );
}

/** No agents yet: the lead on its orbit with empty seats, one light travelling round. */
export function NoAgents({ title = "No agents yet", description = "Add an agent and it takes its seat around the lead.", ...rest }: EmptyStateProps) {
  const orbit = "M30 50a50 26 0 1 0 100 0a50 26 0 1 0 -100 0";
  return (
    <Frame
      name="no-agents"
      label="An empty orbit around the lead agent"
      title={title}
      description={description}
      {...rest}
      art={
        <>
          <path d={orbit} fill="none" stroke="currentColor" strokeOpacity={INK.line} strokeWidth={1.25} />
          {[
            [30, 50],
            [130, 50],
            [80, 76],
          ].map(([x, y]) => (
            <Ring key={`${x}${y}`} x={x} y={y} r={7} />
          ))}
          <Box x={68} y={40} w={24} h={20} r={6} strong />
          <Text x={74} y={50} w={12} strong />
          <circle r={3.5} fill={ACCENT} style={{ offsetPath: `path("${orbit}")`, offsetRotate: "0deg", animation: "knes-orbit 6s linear infinite" } as CSSProperties} cx={0} cy={0} />
        </>
      }
    />
  );
}

/** No results: a search with nothing under it, the lens scanning. */
export function NoResults({ title = "No results", description = "Try fewer words, or search the docs instead.", ...rest }: EmptyStateProps) {
  return (
    <Frame
      name="no-results"
      label="A search with no results"
      title={title}
      description={description}
      {...rest}
      art={
        <>
          <Box x={26} y={12} w={108} h={22} r={6} strong />
          <Text x={48} y={23} w={40} strong />
          <g style={{ animation: "knes-scan 3.2s cubic-bezier(.22,1,.36,1) infinite" }}>
            <circle cx={36} cy={23} r={4.5} fill="none" stroke={ACCENT} strokeWidth={1.5} />
            <path d="M39.4 26.4l3 3" stroke={ACCENT} strokeWidth={1.5} strokeLinecap="round" />
          </g>
          {[50, 64, 78].map((y, i) => (
            <rect key={y} x={26} y={y - 5} width={108 - i * 18} height={10} rx={5} fill="currentColor" fillOpacity={INK.fill} />
          ))}
        </>
      }
    />
  );
}

/** Your own art in the same frame (title, description, action, pause handling). Draw in a 160 x 100 viewBox. */
export function EmptyState({ art, label, ...rest }: EmptyStateProps & { art: ReactNode; label: string }) {
  return <Frame name="empty-state" art={art} label={label} {...rest} />;
}
