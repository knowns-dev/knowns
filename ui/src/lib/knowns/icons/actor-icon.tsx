import type { ReactNode } from "react";
import type { Actor } from "@/ui/lib/knowns/types";
import { modelIcon } from "./model-icons";
import { toolIcon } from "./tool-icons";

export const PersonGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="4" fill="currentColor" />
    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
  </svg>
);

export const BotGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="3" r="1.4" fill="currentColor" />
    <rect x="4" y="7" width="16" height="13" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="9" cy="13" r="1.6" fill="currentColor" />
    <circle cx="15" cy="13" r="1.6" fill="currentColor" />
    <path d="M9.5 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const SparkGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.5l2.1 6.2 6.4 2.3-6.4 2.3L12 19.5l-2.1-6.2L3.5 11l6.4-2.3z" fill="currentColor" />
  </svg>
);

/**
 * Icon for an actor: its own `icon`, else the provider logo of its model (agents),
 * the brand logo or a glyph matching its label (tools), else a built-in glyph.
 * Fill a sized box with it: `<span className="size-5 [&>svg]:size-full">{actorIcon(a)}</span>`.
 */
export function actorIcon(actor: Actor, isRoot = false): ReactNode {
  if (actor.icon) return actor.icon;
  if (actor.type === "agent") return modelIcon(actor.model) ?? (isRoot ? <SparkGlyph /> : <BotGlyph />);
  if (actor.type === "tool") return toolIcon(actor.label) ?? actor.label.trim().charAt(0).toUpperCase();
  return <PersonGlyph />;
}
