import type { Actor, ActorState } from "./types";

export const STATE_LABEL: Record<ActorState, string> = {
  idle: "Idle",
  busy: "Working",
  blocked: "Needs you",
  failed: "Failed",
  finished: "Done",
};

/** Text colour for a state, light and dark. */
export const STATE_TEXT: Record<ActorState, string> = {
  idle: "text-muted-foreground",
  busy: "text-indigo-600 dark:text-indigo-400",
  blocked: "text-amber-700 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
  finished: "text-emerald-700 dark:text-emerald-400",
};

/** Agent colours, assigned in tree order. Links and streaks use the colour of their agent. */
export const AGENT_PALETTE = ["#6366f1", "#0ea5e9", "#8b5cf6", "#14b8a6", "#ec4899", "#06b6d4", "#3b82f6"];

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;

const INK_DARK = "#0a0a0a";
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Text colour for small text set on a solid `fill`, and the fill to use, so the pair reaches 4.5:1 (WCAG AA).
 * Picks near-black or white ink; when neither reaches 4.5:1 (mid tones like #6366f1), darkens the fill a little
 * under white ink. Non-hex fills (CSS variables, oklch) get white ink on a darker colour-mix.
 */
export function readableInk(fill: string): { ink: string; fill: string } {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return { ink: "#ffffff", fill: `color-mix(in srgb, ${fill} 70%, black)` };
  const onWhite = contrastRatio("#ffffff", fill);
  const onDark = contrastRatio(INK_DARK, fill);
  if (onDark >= 4.5 && onDark >= onWhite) return { ink: INK_DARK, fill };
  if (onWhite >= 4.5) return { ink: "#ffffff", fill };
  return { ink: "#ffffff", fill: `color-mix(in srgb, ${fill} 85%, black)` };
}

/** The coordinating agent: the one marked `root`, else the first agent. */
export function rootAgent(actors: Actor[]): Actor | undefined {
  const agents = actors.filter((a) => a.type === "agent");
  return agents.find((a) => a.root) ?? agents[0];
}

export function initials(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.trim().slice(0, 2).toUpperCase();
}

/**
 * One colour per agent, the same in every component: root agent first,
 * then the other agents in the order they appear.
 */
export function actorColors(actors: Actor[]): Map<string, string> {
  const root = rootAgent(actors);
  const agents = actors.filter((a) => a.type === "agent");
  const ordered = root ? [root, ...agents.filter((a) => a !== root)] : agents;
  return new Map(ordered.map((a, i) => [a.id, AGENT_PALETTE[i % AGENT_PALETTE.length]]));
}

/** Colour for a span or link: the specialist agent end, else any agent end, else indigo. */
export function spanColor(colors: Map<string, string>, rootId: string | undefined, a: string, b: string) {
  const ends = [a, b].filter((id) => colors.has(id));
  const specialist = ends.find((id) => id !== rootId);
  return colors.get(specialist ?? ends[0] ?? "") ?? "#6366f1";
}
