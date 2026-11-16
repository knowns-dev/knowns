// Built-in skill files in differential tree snapshots (init, setup, sync, agents).
//
// The Go oracle is frozen at the last Go commit (go-src.ts) while cli/instructions/skills keeps
// changing, so a synced skill file can no longer be byte-equal on both sides. A file whose bytes
// are exactly a built-in skill, either the oracle's pinned copy or the current embed, is reduced to
// <builtin-skill:kn-x/SKILL.md>: both sides must still write the same set of skill files, each one
// a real built-in, at the same paths. Anything else (stale, user-owned, truncated) stays as bytes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { skillFiles } from "../../src/domain/instructions/embedded.generated.ts";
import { GO_SRC } from "./go-src.ts";

function goSkillFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!GO_SRC) return out;
  const base = join(GO_SRC, "internal", "instructions", "skills");
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e.startsWith("_")) continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(base, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

const GO_SKILLS = goSkillFiles();
const SKILL_PATH = /(?:^|\/)skills\/(kn-[^/]+\/.+)$/;

/** `<builtin-skill:key>` when `text` at `rel` is exactly a built-in skill file of either side. */
export function builtinSkill(rel: string, text: string): string | undefined {
  const key = SKILL_PATH.exec(rel)?.[1];
  if (!key) return undefined;
  return text === skillFiles[key] || text === GO_SKILLS[key] ? `<builtin-skill:${key}>` : undefined;
}
