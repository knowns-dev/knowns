// Port of internal/mcp/handlers/initial.go.

import type { LanguageRuntimeStatus } from "../../lsp/types.ts";
import { deriveTaskIdPrefix } from "../../models/id.ts";
import { getLspStatuses } from "../lsp-status.ts";
import type { McpState, Project } from "../state.ts";
import { type CallToolResult, textResult } from "../tool.ts";

const CSHARP = "csharp";

export async function handle(
  state: McpState,
  ctx: { signal?: AbortSignal },
): Promise<CallToolResult> {
  let statuses: LanguageRuntimeStatus[] | undefined = await getLspStatuses(state, ctx.signal);
  if ((!statuses || statuses.length === 0) && state.getProject()) {
    const manager = await state.getLspManager();
    if (manager) statuses = await manager.runtimeStatuses(ctx.signal);
  }
  return textResult(await buildInitialInstructions(state.getProject(), statuses ?? []));
}

export async function buildInitialInstructions(
  project: Project | undefined,
  statuses: LanguageRuntimeStatus[],
): Promise<string> {
  let b = "# Knowns MCP — Session Ready\n\n";
  b += await writeProjectState(project, statuses);
  b += "\n";
  b += CODE_RULES;
  b += "\n";
  b += WORKFLOW;
  b += "\n";
  b += KNOWLEDGE_LIFECYCLE;
  b += "\n";
  b += TOOLS_SUMMARY;
  return b;
}

async function writeProjectState(
  project: Project | undefined,
  statuses: LanguageRuntimeStatus[],
): Promise<string> {
  let b = "## Project State\n";
  if (!project) {
    b += "Project: not connected\n";
    return b;
  }
  const { storage } = project;
  const { buildReadiness } = await import("../../domain/readiness/index.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const payload = buildReadiness(storage, buildSearchEnvironment(), {});
  const inProgress = countInProgressTasks(project);
  b += `Project: ${payload.projectName}\n`;
  try {
    const cfg = storage.config.load();
    let prefix = cfg.settings.defaultTaskIdPrefix ?? "";
    let source = "settings.defaultTaskIdPrefix";
    if (prefix === "") {
      prefix = deriveTaskIdPrefix(cfg.name);
      source = "derived from project name";
    }
    b += `Task IDs: new=${prefix}-4F7Q2M (${source}) | use verbatim, ${prefix}- is part of the ID not a task- ref | older IDs like 4f7q2m stay valid | per-task override: tasks.create prefix=<2-8 chars> | default changes via CLI settings.defaultTaskIdPrefix\n`;
  } catch {
    // config unreadable: no Task IDs line
  }
  const k = payload.knowledge;
  if (k) {
    b += `Knowledge: docs: ${k.docs} | tasks: ${k.tasks} (${inProgress} in-progress) | templates: ${k.templates} | memories: ${k.memories.project}p, ${k.memories.global}g (${k.memories.legacyDecision} legacy Decision) | decisions: ${k.decisions.current} current, ${k.decisions.draft} draft, ${k.decisions.historical} historical\n`;
    if (k.memories.awaitingReview > 0) {
      b += `⚠ ${k.memories.awaitingReview} memories awaiting review and NOT retrievable until resolved: memory(action:"list", status:"proposed") then resolve or delete\n`;
    }
  }
  const timerLine = activeTimerLine(project);
  if (timerLine !== "") b += `${timerLine}\n`;
  const lspLine = lspWarningsLine(statuses);
  if (lspLine !== "") b += `${lspLine}\n`;
  const semanticLine = await semanticRuntimeLine(project);
  if (semanticLine !== "") b += `${semanticLine}\n`;
  // CodeRefIndexExists is a compatibility stub that always reports false.
  b += "Code index: symbols: 0 | relations: 0\n";
  return b;
}

function countInProgressTasks(project: Project): number {
  try {
    return project.storage.tasks.listActive().filter((t) => t.status === "in-progress").length;
  } catch {
    return 0;
  }
}

function activeTimerLine(project: Project): string {
  let state: ReturnType<Project["storage"]["time"]["getState"]>;
  try {
    state = project.storage.time.getState();
  } catch {
    return "";
  }
  const timer = state.active?.[0];
  if (!timer) return "";
  const startedAt = Date.parse(timer.startedAt);
  if (Number.isNaN(startedAt)) return `⏱ Active timer: ${timer.taskId} "${timer.taskTitle}"`;
  const pausedMs = timer.totalPausedMs ?? 0;
  let elapsed = Date.now() - startedAt - pausedMs;
  if (timer.pausedAt) {
    const pausedAt = Date.parse(timer.pausedAt);
    if (!Number.isNaN(pausedAt)) elapsed = pausedAt - startedAt - pausedMs;
  }
  if (elapsed < 0) elapsed = 0;
  return `⏱ Active timer: ${timer.taskId} "${timer.taskTitle}" (${formatInitialDuration(elapsed)})`;
}

/** d.Round(time.Minute): half away from zero, then "XhYm" / "Zm". */
function formatInitialDuration(ms: number): string {
  const minute = 60_000;
  let d = Math.floor((ms + minute / 2) / minute) * minute;
  if (d < minute) return "0m";
  d = Math.round(d / minute);
  const hours = Math.floor(d / 60);
  const minutes = d % 60;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

function lspWarningsLine(statuses: LanguageRuntimeStatus[]): string {
  const parts: string[] = [];
  for (const status of statuses) {
    if (status.id === CSHARP) {
      parts.push(formatInitialLSPStatus(status));
      continue;
    }
    if (!status.detected && status.status !== "crashed" && status.status !== "degraded") continue;
    if (
      status.install_state !== "installed" ||
      status.running_state === "crashed" ||
      status.status === "degraded"
    ) {
      parts.push(formatInitialLSPStatus(status));
    }
  }
  return parts.length === 0 ? "" : `LSP runtime: ${parts.join("; ")}`;
}

function formatInitialLSPStatus(s: LanguageRuntimeStatus): string {
  const parts = [s.id];
  if (s.backend) parts.push(`backend=${s.backend}`);
  if (s.source) parts.push(`source=${s.source}`);
  if (s.install_state) parts.push(`install=${s.install_state}`);
  if (s.owner) parts.push(`owner=${s.owner}`);
  if (s.daemon_state) parts.push(`daemon=${s.daemon_state}`);
  if (s.daemon_idle_deadline) parts.push(`idle=${s.daemon_idle_deadline}`);
  if ((s.daemon_lease_count ?? 0) > 0) parts.push(`leases=${s.daemon_lease_count}`);
  if (s.readiness_state && s.readiness_state !== "not_applicable") {
    parts.push(`readiness=${s.readiness_state}`);
  }
  if (s.status === "degraded") parts.push("status=degraded");
  if ((s.capabilities ?? []).length > 0)
    parts.push(`capabilities=${(s.capabilities ?? []).join(",")}`);
  if ((s.missing_capabilities ?? []).length > 0) {
    parts.push(`missing=${(s.missing_capabilities ?? []).join(",")}`);
  }
  if (s.install_state !== "installed" && s.install_cmd) parts.push(`run=${s.install_cmd}`);
  if (s.log_path) parts.push(`log=${s.log_path}`);
  return parts.join(" ");
}

async function semanticRuntimeLine(project: Project): Promise<string> {
  const { observedSemanticRuntimeStatus } = await import("../../cli/commands/runtime-ps.ts");
  const { formatGoDuration } = await import("../../cli/core/gofmt.ts");
  const { runtimeLogPath } = await import("../../runtime/queue.ts");
  const status = observedSemanticRuntimeStatus();
  const parts = [`enabled=${status.enabled}`];
  if (status.disabledBy) parts.push(`disabled_by=${status.disabledBy}`);
  if (status.idleTimeout > 0) {
    const sec = 1e9;
    const rounded = Math.floor((status.idleTimeout + sec / 2) / sec) * sec;
    parts.push(`idle_timeout=${formatGoDuration(rounded)}`);
  }
  let ss: { enabled?: boolean; provider?: string; model?: string; dimensions?: number } | undefined;
  try {
    ss = project.storage.config.load().settings.semanticSearch ?? undefined;
  } catch {
    ss = undefined;
    parts.push("config=unavailable");
  }
  if (ss) {
    if (!ss.enabled) {
      parts.push("config=disabled");
    } else {
      parts.push(`provider=${ss.provider || "local"}`);
      if (ss.model) parts.push(`model=${ss.model}`);
      if ((ss.dimensions ?? 0) > 0) parts.push(`dims=${ss.dimensions}`);
    }
  } else if (!parts.includes("config=unavailable")) {
    parts.push("config=unavailable");
  }
  let loaded = false;
  let activeSessions = 0;
  let consumers = 0;
  let idleUnloadAfter = 0;
  for (const entry of status.entries) {
    if (entry.loaded) loaded = true;
    activeSessions += entry.activeSessions;
    consumers += entry.storeConsumers.length;
    const t = Date.parse(entry.idleUnloadAfter);
    if (!Number.isNaN(t) && t > idleUnloadAfter) idleUnloadAfter = t;
  }
  parts.push(`loaded=${loaded}`);
  parts.push(`entries=${status.entries.length}`);
  if (activeSessions > 0) parts.push(`sessions=${activeSessions}`);
  if (consumers > 0) parts.push(`consumers=${consumers}`);
  if (idleUnloadAfter > 0 && idleUnloadAfter > Date.parse("0001-01-02T00:00:00Z")) {
    parts.push(`idle=${new Date(idleUnloadAfter).toISOString().replace(/\.\d+Z$/, "Z")}`);
  }
  parts.push(`log=${runtimeLogPath()}`);
  return `Semantic runtime: ${parts.join(" ")}`;
}

const CODE_RULES = `## Code Intelligence Rules
**CRITICAL**: Use Knowns code actions for code discovery, navigation, and structural edits. This is the operating path for code work.

Discovery and navigation:
- code.find: search symbols before opening files
- code.symbols: inspect file structure
- code.definition / code.references / code.implementations: navigate with LSP precision
- code.diagnostics: inspect current language-server errors

Editing actions:
- code.rename: rename symbols with LSP workspace edits
- code.replace: replace exact text after code tools locate the target
- code.replace_body: replace an entire symbol body by name
- code.insert / code.delete: structural insert/delete by symbol anchor

**FORBIDDEN**: Do not use built-in read/grep/edit as the first step for code. Use them only for shell/tests or after code tools identify the target and surrounding context is needed.

If an action schema is not visible, call help("code.*") or help("workflow.code-edit") before editing.
`;

const WORKFLOW = `## Workflow
Bootstrap:     initial → help("workflow.*") or help("<domain>.*") as needed
Discovery:     search(query) → docs/tasks(get) for details
Docs:          docs.get(smart:true) → docs.get(toc:true) → docs.get(section:"...") for large docs
Code context:  code.find → code.symbols → code.references/definition
Code edits:    code.rename/replace/replace_body/insert/delete → diagnostics/tests
Task flow:     tasks(get/create) → follow refs → plan → implement → validate → done
Time:          time(start) when taking task, time(stop) when done
Progress:      tasks(update, appendNotes:"...") — not notes (replaces)

Use help on demand instead of assuming the visible MCP tool schema is complete.
`;

const KNOWLEDGE_LIFECYCLE = `## Knowledge Lifecycle
A Memory is a fact the NEXT session needs, written from an outcome you reached. Not this session's state, not the user's prompt.

- A prompt is a request, not a conclusion. If an entry carries nothing beyond the message that prompted it, it is not a Memory. Write one when work settles something: a bug root-caused, a preference stated and acted on.
- Categories are pattern, convention, failure (claims about the code: cite a symbol, @doc/<path> or @task-<id>, never a line number) and preference (the user's own commitment: cite who said it and when, and give it a **Why:** line, since the reason is what lets a rule reach a case it does not name).
- memory add lands active and is retrieved on the next prompt; a write matching an existing Memory returns review_required instead of overwriting it. Resolve those, or they expire.
- Spec Decisions are stable D-rules in an approved spec's Locked Decisions section; implementers must report every required D-ID.
- System Decisions are the first-class ledger for durable guidance, using verified evidence and supersession rather than overwrite. Memory category 'decision' is legacy and closed; see help("decision.*").
`;

const TOOLS_SUMMARY = `## Tools (discover with help)
code | tasks | docs | search | time | templates | validate | memory | decision | project | help
Recipes: help("workflow.code-edit"), help("workflow.doc-read"), help("workflow.plan-new"), help("workflow.spec"), help("workflow.verify")`;
