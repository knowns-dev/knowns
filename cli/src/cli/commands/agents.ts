// `knowns agents` (internal/cli/agents.go): the status of each agent instruction file.
import { agentStatuses, type PlatformStatus } from "../../domain/setup/agents-status.ts";
import { defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import {
  renderSectionHeader,
  renderSeparator,
  StyleBold,
  StyleDim,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";

/** padEnd by rune count, like Go's %-Ns. */
const padRunes = (s: string, n: number): string => {
  const len = [...s].length;
  return len >= n ? s : s + " ".repeat(n - len);
};

export function renderAgentsPlain(statuses: PlatformStatus[]): string {
  let out = `PLATFORMS: ${statuses.length}\n\n`;
  for (const ps of statuses) {
    out += `PLATFORM: ${ps.name}\n`;
    out += `  LABEL: ${ps.label}\n`;
    out += `  FILE: ${ps.fileName}\n`;
    out += `  STATUS: ${ps.exists ? "exists" : "missing"}\n`;
    if (ps.exists) out += `  SIZE: ${ps.sizeBytes ?? 0} bytes\n`;
    out += "\n";
  }
  return out;
}

export function renderAgentsStyled(statuses: PlatformStatus[]): string {
  let out = `${renderSectionHeader("Agent Instruction Files")}\n`;
  out += `${renderSeparator(70)}\n`;
  out += `${StyleBold.render(padRunes("PLATFORM", 16))}  ${StyleBold.render(padRunes("FILE", 45))}  ${StyleBold.render("STATUS")}\n`;
  out += `${renderSeparator(70)}\n`;
  for (const ps of statuses) {
    const status = ps.exists ? StyleSuccess.render("exists") : StyleWarning.render("missing");
    out += `${padRunes(ps.label, 16)}  ${padRunes(ps.fileName, 45)}  ${status}\n`;
  }
  out += "\n";
  const existing = statuses.filter((s) => s.exists).length;
  out += `${StyleBold.render(String(existing))} of ${statuses.length} instruction files found.\n`;
  if (existing < statuses.length) {
    out += `${StyleDim.render("Use 'knowns sync --instructions' to generate missing files.")}\n`;
  }
  return out;
}

export default defineCommand({
  use: "agents",
  short: "Manage agent instruction files",
  long: `Manage AI agent instruction files
(CLAUDE.md, OPENCODE.md, GEMINI.md, AGENTS.md,
.github/copilot-instructions.md).

Shows the status of instruction files for each supported AI platform and
can sync/generate them from project configuration.`,
  async run(ctx) {
    const store = await getStoreErr(ctx.cmd);
    const statuses = agentStatuses(store.projectRoot);
    if (ctx.json) ctx.printJSON(statuses);
    else if (ctx.plain) ctx.print(renderAgentsPlain(statuses));
    else ctx.print(renderAgentsStyled(statuses));
  },
});
