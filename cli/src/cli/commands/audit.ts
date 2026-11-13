// `knowns audit` (internal/cli/audit.go): inspect the MCP tool call audit trail.
import type { AuditEvent } from "../../models/audit.ts";
import { defineCommand } from "../core/define.ts";
import {
  renderField,
  renderInfo,
  renderSectionHeader,
  renderSeparator,
  StyleBold,
  StyleDim,
  StyleError,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";

async function store() {
  const { AuditStore } = await import("../../storage/stores/audit-store.ts");
  return new AuditStore();
}

const filterFlags = [
  { type: "string", name: "tool", usage: "Filter by tool name", default: "" },
  { type: "string", name: "project", usage: "Filter by project root path", default: "" },
] as const;

/** The wall clock of the stored timestamp, in the offset it was written with (Go keeps it). */
const wall = (ts: string, from: number, to: number): string => ts.replace("T", " ").slice(from, to);

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - [...s].length));
const padLeft = (s: string, n: number): string => " ".repeat(Math.max(0, n - s.length)) + s;

const recent = defineCommand({
  use: "recent",
  short: "Show recent MCP tool calls",
  flags: [
    { type: "int", name: "limit", usage: "Maximum number of events to show", default: 50 },
    filterFlags[0],
    {
      type: "string",
      name: "result",
      usage: "Filter by result (success, error, denied)",
      default: "",
    },
    filterFlags[1],
  ],
  async run(ctx) {
    const f = {
      toolName: ctx.flags.string("tool"),
      result: ctx.flags.string("result"),
      project: ctx.flags.string("project"),
    };
    const filter = f.toolName || f.result || f.project ? f : undefined;
    let events: AuditEvent[];
    try {
      events = (await store()).recent(ctx.flags.int("limit"), filter);
    } catch (e) {
      throw new Error(`audit recent: ${(e as Error).message}`);
    }
    if (ctx.json) {
      ctx.printJSON(events.length === 0 ? null : events);
      return;
    }
    if (events.length === 0) {
      ctx.print(`${ctx.plain ? "No audit events found." : renderInfo("No audit events found.")}\n`);
      return;
    }
    const toolOf = (e: AuditEvent) => (e.action ? `${e.toolName}.${e.action}` : e.toolName);
    if (ctx.plain) {
      let out = "";
      for (const e of events) {
        let line = `${wall(e.timestamp, 0, 19)}  ${pad(toolOf(e), 22)}  ${pad(e.actionClass, 7)}  ${pad(e.result, 7)}  ${e.durationMs}ms`;
        if (e.dryRun) line += "  [dry-run]";
        if (e.errorMessage) line += `  err=${e.errorMessage}`;
        if (e.entityRefs && e.entityRefs.length > 0) line += `  refs=${e.entityRefs.join(",")}`;
        out += `${line}\n`;
      }
      ctx.print(out);
      return;
    }
    let out = `${renderSectionHeader(`Recent MCP Activity (${events.length} events)`)}\n`;
    out += `${renderSeparator(60)}\n\n`;
    for (const e of events) {
      const result =
        e.result === "success"
          ? StyleSuccess.render("✓")
          : e.result === "error"
            ? StyleError.render("✗")
            : e.result === "denied"
              ? StyleWarning.render("⊘")
              : e.result;
      let line = `  ${StyleDim.render(wall(e.timestamp, 11, 19))}  ${result} ${StyleInfo.render(toolOf(e))}  ${StyleDim.render(`[${e.actionClass}]`)}  ${StyleDim.render(`${e.durationMs}ms`)}`;
      if (e.dryRun) line += `  ${StyleWarning.render("[dry-run]")}`;
      out += `${line}\n`;
      if (e.errorMessage) out += `         ${StyleError.render(e.errorMessage)}\n`;
      if (e.entityRefs && e.entityRefs.length > 0) {
        out += `         ${StyleDim.render(e.entityRefs.join(", "))}\n`;
      }
    }
    ctx.print(`${out}\n`);
  },
});

const stats = defineCommand({
  use: "stats",
  short: "Show MCP tool call statistics",
  flags: [filterFlags[0], filterFlags[1]],
  async run(ctx) {
    const f = { toolName: ctx.flags.string("tool"), project: ctx.flags.string("project") };
    let s: ReturnType<Awaited<ReturnType<typeof store>>["stats"]>;
    try {
      s = (await store()).stats(f.toolName || f.project ? f : undefined);
    } catch (e) {
      throw new Error(`audit stats: ${(e as Error).message}`);
    }
    if (ctx.json) {
      ctx.printJSON(s);
      return;
    }
    if (s.totalCalls === 0) {
      ctx.print(`${ctx.plain ? "No audit events found." : renderInfo("No audit events found.")}\n`);
      return;
    }
    const entries = (m: Record<string, number> | null | undefined) => Object.entries(m ?? {});
    const toolKeys = Object.keys(s.byTool ?? {}).sort();
    const parts = (tool: string) =>
      entries(s.byToolResult?.[tool])
        .map(([r, c]) => `${r}:${c}`)
        .join(", ");
    let out = "";
    if (ctx.plain) {
      out += `Total calls: ${s.totalCalls}\nExecuted: ${s.executeCount}  Dry-run: ${s.dryRunCount}\n\nBy result:\n`;
      for (const [r, c] of entries(s.byResult)) out += `  ${pad(r, 10)} ${c}\n`;
      out += "\nBy action class:\n";
      for (const [r, c] of entries(s.byActionClass)) out += `  ${pad(r, 10)} ${c}\n`;
      out += "\nBy tool:\n";
      for (const t of toolKeys) {
        out += `  ${pad(t, 25)} ${padLeft(String(s.byTool?.[t] ?? 0), 4)}  (${parts(t)})\n`;
      }
      ctx.print(out);
      return;
    }
    out += `${renderSectionHeader("MCP Audit Statistics")}\n${renderSeparator(50)}\n\n`;
    out += `${renderField("Total calls", String(s.totalCalls))}\n`;
    out += `${renderField("Executed", String(s.executeCount))}\n`;
    out += `${renderField("Dry-run", String(s.dryRunCount))}\n\n`;
    out += `${renderSectionHeader("By Result")}\n`;
    for (const [r, c] of entries(s.byResult)) {
      const styled =
        r === "success"
          ? StyleSuccess.render(r)
          : r === "error"
            ? StyleError.render(r)
            : r === "denied"
              ? StyleWarning.render(r)
              : r;
      out += `  ${pad(styled, 20 + (styled.length - r.length))} ${c}\n`;
    }
    out += `\n${renderSectionHeader("By Action Class")}\n`;
    for (const [r, c] of entries(s.byActionClass)) out += `  ${pad(r, 15)} ${c}\n`;
    out += `\n${renderSectionHeader("By Tool")}\n`;
    for (const t of toolKeys) {
      out += `  ${StyleInfo.render(t)}${" ".repeat(Math.max(0, 25 - t.length))} ${StyleBold.render(padLeft(String(s.byTool?.[t] ?? 0), 4))}  ${StyleDim.render(`(${parts(t)})`)}\n`;
    }
    ctx.print(`${out}\n`);
  },
});

export default defineCommand({
  use: "audit",
  short: "Inspect MCP tool call audit trail",
  subcommands: [recent, stats],
});
