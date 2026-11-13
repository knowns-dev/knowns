// `knowns status` (internal/cli/status.go): the project readiness summary.
import type { LSPStatus, Payload } from "../../domain/readiness/index.ts";
import { defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import { StyleBold, StyleDim, StyleInfo, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";

/** formatTimeSince: "just now", "5m ago", "3h ago", "2d ago". */
export function formatTimeSince(t: string, now: number = Date.now()): string {
  const d = now - Date.parse(t);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.trunc(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.trunc(d / 3_600_000)}h ago`;
  return `${Math.trunc(d / 3_600_000 / 24)}d ago`;
}

export function renderStatusPlain(p: Payload, now: number = Date.now()): string {
  if (!p.active) return "No active project.\n";
  let out = `Project: ${p.projectName} (${p.projectPath})\n`;
  out += `Version: ${p.version}\n`;

  const k = p.knowledge;
  if (k) {
    const totalMem = k.memories.project + k.memories.global;
    out += `Knowledge: ${k.docs} docs, ${k.tasks} tasks, ${k.templates} templates, ${totalMem} memories, ${k.decisions.total} decisions, ${k.relations} relations\n`;
    out += `Decisions: ${k.decisions.current} current, ${k.decisions.draft} draft, ${k.decisions.historical} historical; ${k.memories.legacyDecision} legacy Decision Memories\n`;
    if (k.imports > 0) out += `Imports: ${k.imports} active sources\n`;
  }

  const s = p.search;
  if (s) {
    if (s.semanticEnabled && s.modelInstalled && s.projectIndexReady) {
      const freshness = s.lastReindex ? formatTimeSince(s.lastReindex, now) : "unknown";
      out += `Search: semantic ready, indices fresh (${freshness})\n`;
    } else if (s.semanticEnabled && !s.modelInstalled) {
      out += "Search: semantic enabled but model not installed\n";
    } else if (s.semanticEnabled && !s.projectIndexReady) {
      out += "Search: semantic enabled but index empty (run: knowns search --reindex)\n";
    } else {
      out += "Search: keyword-only mode\n";
    }
    if (s.semanticEnabled && s.semanticDegraded) {
      out += `Search: semantic degraded (${s.semanticDegradedReason ?? ""})\n`;
    }
  }

  const r = p.runtime;
  if (r) {
    if (r.running) {
      out += `Runtime: ${r.state}, ${r.connectedClients} clients, ${r.queuedJobs} queued, ${r.runningJobs} running\n`;
    } else if (r.enabled) {
      out += "Runtime: enabled but not running\n";
    } else {
      out += "Runtime: disabled\n";
    }
  } else {
    out += "Runtime: not running\n";
  }

  if (p.lsp && p.lsp.length > 0) {
    const parts = p.lsp.map((item: LSPStatus) => {
      let detail = item.status;
      if ((item.backend ?? "") !== "") detail += `/${item.backend}`;
      if (item.readinessState !== "" && item.readinessState !== "not_applicable") {
        detail += ` readiness=${item.readinessState}`;
      }
      if (item.status === "not_installed" && (item.installCmd ?? "") !== "") {
        return `${item.id}=${item.status} (run: ${item.installCmd})`;
      }
      return `${item.id}=${detail}`;
    });
    out += `LSP: ${parts.join(", ")}\n`;
  }

  if (p.capabilities && p.capabilities.length > 0) {
    out += `Capabilities: ${p.capabilities.join(", ")}\n`;
  }
  return out;
}

export function renderStatusStyled(p: Payload, now: number = Date.now()): string {
  if (!p.active) return `${StyleWarning.render("No active project.")}\n`;
  let out = `${StyleBold.render("Project:")} ${StyleSuccess.render(p.projectName)}\n`;
  out += `${StyleDim.render("  Path:")} ${p.projectPath}\n`;
  out += `${StyleDim.render("  Version:")} ${p.version}\n`;
  out += "\n";

  const k = p.knowledge;
  if (k) {
    const totalMem = k.memories.project + k.memories.global;
    out += `${StyleBold.render("Knowledge")}\n`;
    out += `  ${StyleSuccess.render("✓")} ${k.docs} docs, ${k.tasks} tasks, ${k.templates} templates\n`;
    out += `  ${StyleSuccess.render("✓")} ${totalMem} memories (${k.memories.project} project, ${k.memories.global} global)\n`;
    out += `  ${StyleSuccess.render("✓")} ${k.decisions.total} System Decisions (${k.decisions.current} current, ${k.decisions.draft} draft, ${k.decisions.historical} historical)\n`;
    if (k.memories.legacyDecision > 0) {
      out += `  ${StyleWarning.render("⚠")} ${k.memories.legacyDecision} legacy Decision Memories await reviewed migration\n`;
    }
    if (k.relations > 0) out += `  ${StyleSuccess.render("✓")} ${k.relations} relations\n`;
    if (k.imports > 0) out += `  ${StyleInfo.render("↓")} ${k.imports} import sources\n`;
    out += "\n";
  }

  const s = p.search;
  if (s) {
    out += `${StyleBold.render("Search")}\n`;
    if (s.semanticEnabled && s.modelInstalled && s.projectIndexReady) {
      const freshness = s.lastReindex ? formatTimeSince(s.lastReindex, now) : "unknown";
      out += `  ${StyleSuccess.render("✓")} semantic ready, indices fresh (${freshness})\n`;
    } else if (!s.semanticEnabled) {
      out += `  ${StyleDim.render("○")} keyword-only mode\n`;
    } else if (!s.modelInstalled) {
      out += `  ${StyleWarning.render("⚠")} model not installed\n`;
    } else if (!s.projectIndexReady) {
      out += `  ${StyleWarning.render("⚠")} index empty — run: knowns search --reindex\n`;
    }
    if (s.semanticEnabled && s.semanticDegraded) {
      out += `  ${StyleWarning.render("⚠")} semantic degraded: ${s.semanticDegradedReason ?? ""}\n`;
    }
    out += "\n";
  }

  out += `${StyleBold.render("Runtime")}\n`;
  const r = p.runtime;
  if (r) {
    if (r.running && r.state === "healthy") {
      out += `  ${StyleSuccess.render("✓")} healthy, ${r.connectedClients} clients, ${r.queuedJobs} queued, ${r.runningJobs} running\n`;
    } else if (r.running && r.state === "degraded") {
      out += `  ${StyleWarning.render("⚠")} degraded, ${r.connectedClients} clients\n`;
    } else if (r.enabled) {
      out += `  ${StyleWarning.render("⚠")} enabled but not running\n`;
    } else {
      out += `  ${StyleDim.render("○")} disabled\n`;
    }
  } else {
    out += `  ${StyleDim.render("○")} not running\n`;
  }
  out += "\n";

  if (p.lsp && p.lsp.length > 0) {
    out += `${StyleBold.render("LSP")}\n`;
    for (const item of p.lsp) {
      let marker = StyleDim.render("○");
      if (item.status === "running" || item.status === "installed")
        marker = StyleSuccess.render("✓");
      else if (item.status === "not_installed" && (item.installCmd ?? "") !== "") {
        marker = StyleWarning.render("⚠");
      }
      let line = `  ${marker} ${item.id}: ${item.status}`;
      if ((item.backend ?? "") !== "") line += ` backend=${item.backend}`;
      if ((item.binary ?? "") !== "") line += ` (${item.binary} via ${item.source ?? ""})`;
      if (item.readinessState !== "" && item.readinessState !== "not_applicable") {
        line += ` readiness=${item.readinessState}`;
      }
      if ((item.logPath ?? "") !== "") line += ` log=${item.logPath}`;
      out += `${line}\n`;
      if (item.status === "not_installed" && (item.installCmd ?? "") !== "") {
        out += `    Run: ${item.installCmd}\n`;
      }
    }
    out += "\n";
  }

  if (p.capabilities && p.capabilities.length > 0) {
    out += `${StyleBold.render("Capabilities")}\n`;
    out += `  ${p.capabilities.join(", ")}\n`;
    out += "\n";
  }
  return out;
}

export default defineCommand({
  use: "status",
  short: "Show project readiness summary",
  long: `Display a unified readiness summary for the active Knowns project.

Shows project identity, knowledge counts, search status, runtime health,
and available capabilities in one view.

Use --json for structured output consumed by scripts or AI clients.
Use --plain for clean text output suitable for piping.`,
  async run(ctx) {
    const { inactivePayload, buildReadiness, loadRuntimeReadiness } = await import(
      "../../domain/readiness/index.ts"
    );
    let store: Awaited<ReturnType<typeof getStoreErr>>;
    try {
      store = await getStoreErr(ctx.cmd);
    } catch (e) {
      if (ctx.json) {
        ctx.printJSON(inactivePayload());
        return;
      }
      throw e;
    }
    const { createStorage } = await import("../../storage/adapters.ts");
    const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
    const storage = createStorage(store);
    const { collectProjectRuntimeStatuses, lspStatusFromRuntime } = await import(
      "../../lsp/project.ts"
    );
    const lsp = (await collectProjectRuntimeStatuses(store.projectRoot)).map(
      (s) => lspStatusFromRuntime(s) as unknown as LSPStatus,
    );
    const payload = buildReadiness(storage, buildSearchEnvironment({ env: ctx.env }), {
      lsp,
      runtime: loadRuntimeReadiness(ctx.env),
    });

    if (ctx.json) ctx.printJSON(payload);
    else if (ctx.plain) ctx.print(renderStatusPlain(payload));
    else ctx.print(renderStatusStyled(payload));
  },
});
