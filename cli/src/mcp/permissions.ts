// Port of internal/permissions (registry.go, policy.go, guard.go): the shared action registry,
// preset policies, and the guard that runs before every MCP tool handler.
import type { PermissionConfig } from "../models/config.ts";
import { type Args, marshalIndent } from "./gojson.ts";
import { type CallToolRequest, type CallToolResult, errorResult } from "./tool.ts";

export const CapRead = "read";
export const CapWrite = "write";
export const CapGenerate = "generate";
export const CapArchive = "archive";
export const CapDelete = "delete";
export const CapAdmin = "admin";

export interface ActionMeta {
  capability: string;
  target: string;
  risk: string;
}

const m = (capability: string, target: string, risk: string): ActionMeta => ({
  capability,
  target,
  risk,
});

export const ACTION_REGISTRY: Record<string, ActionMeta> = {
  "project.detect": m(CapRead, "runtime", "low"),
  "project.current": m(CapRead, "runtime", "low"),
  "project.set": m(CapAdmin, "runtime", "medium"),
  "project.status": m(CapRead, "runtime", "low"),

  "tasks.create": m(CapWrite, "task", "medium"),
  "tasks.get": m(CapRead, "task", "low"),
  "tasks.update": m(CapWrite, "task", "medium"),
  "tasks.delete": m(CapDelete, "task", "high"),
  "tasks.list": m(CapRead, "task", "low"),
  "tasks.history": m(CapRead, "task", "low"),
  "tasks.board": m(CapRead, "task", "low"),
  "tasks.archive": m(CapArchive, "task", "medium"),
  "tasks.unarchive": m(CapArchive, "task", "medium"),
  "tasks.batch_archive": m(CapArchive, "task", "medium"),
  "tasks.batch_unarchive": m(CapArchive, "task", "medium"),
  "tasks.hard_delete": m(CapDelete, "task", "high"),
  // Not in Go's registry (it fell through to read): restoring rewrites the task file.
  "tasks.restore": m(CapWrite, "task", "medium"),

  "docs.create": m(CapWrite, "doc", "medium"),
  "docs.get": m(CapRead, "doc", "low"),
  "docs.update": m(CapWrite, "doc", "medium"),
  "docs.delete": m(CapDelete, "doc", "high"),
  "docs.hard_delete": m(CapDelete, "doc", "high"),
  "docs.list": m(CapRead, "doc", "low"),
  "docs.history": m(CapRead, "doc", "low"),
  // Not in Go's registry: diff only reads; restore overwrites the doc's content.
  "docs.diff": m(CapRead, "doc", "low"),
  "docs.restore": m(CapWrite, "doc", "medium"),

  "memory.add": m(CapWrite, "memory", "medium"),
  "memory.get": m(CapRead, "memory", "low"),
  "memory.update": m(CapWrite, "memory", "medium"),
  "memory.delete": m(CapDelete, "memory", "high"),
  "memory.list": m(CapRead, "memory", "low"),
  "memory.promote": m(CapWrite, "memory", "medium"),
  "memory.demote": m(CapWrite, "memory", "medium"),
  // Not in Go's registry: all four rewrite or remove memory entries. cleanup only removes expired
  // entries, so it is a write (allowed by the default no-delete preset, as in Go), not a delete.
  "memory.cleanup": m(CapWrite, "memory", "medium"),
  "memory.confirm": m(CapWrite, "memory", "medium"),
  "memory.contradict": m(CapWrite, "memory", "medium"),
  "memory.resolve": m(CapWrite, "memory", "medium"),

  // Not in Go's registry at all, so a read-only session could create, accept and supersede
  // decisions (durable project guidance) and apply migrations.
  "decision.get": m(CapRead, "decision", "low"),
  "decision.list": m(CapRead, "decision", "low"),
  "decision.review_inbox": m(CapRead, "decision", "low"),
  "decision.migration_preview": m(CapRead, "decision", "low"),
  "decision.create": m(CapWrite, "decision", "medium"),
  "decision.link": m(CapWrite, "decision", "medium"),
  "decision.resolve": m(CapWrite, "decision", "medium"),
  "decision.accept": m(CapWrite, "decision", "high"),
  "decision.supersede": m(CapWrite, "decision", "high"),
  "decision.migration_apply": m(CapWrite, "decision", "high"),
  "decision.migration_rollback": m(CapWrite, "decision", "high"),

  "time.start": m(CapWrite, "time", "low"),
  "time.stop": m(CapWrite, "time", "low"),
  "time.add": m(CapWrite, "time", "medium"),
  "time.report": m(CapRead, "time", "low"),

  "search.search": m(CapRead, "search", "low"),
  "search.retrieve": m(CapRead, "search", "low"),
  "search.resolve": m(CapRead, "search", "low"),

  "code.search": m(CapRead, "code", "low"),
  "code.symbols": m(CapRead, "code", "low"),
  "code.deps": m(CapRead, "code", "low"),
  "code.graph": m(CapRead, "code", "low"),
  "code.find": m(CapRead, "code", "low"),
  "code.definition": m(CapRead, "code", "low"),
  "code.references": m(CapRead, "code", "low"),
  "code.implementations": m(CapRead, "code", "low"),
  "code.diagnostics": m(CapRead, "code", "low"),
  "code.rename": m(CapWrite, "code", "high"),
  "code.replace": m(CapWrite, "code", "high"),
  "code.replace_body": m(CapWrite, "code", "high"),
  "code.insert": m(CapWrite, "code", "high"),
  "code.delete": m(CapDelete, "code", "high"),

  "templates.create": m(CapWrite, "template", "medium"),
  "templates.get": m(CapRead, "template", "low"),
  "templates.list": m(CapRead, "template", "low"),
  "templates.run": m(CapGenerate, "template", "medium"),

  "validate.default": m(CapRead, "runtime", "low"),
  "validate.fix": m(CapWrite, "runtime", "medium"),
};

// Go falls back to read for an unlisted action of these tools, which is how the actions above
// slipped past read-only sessions. Here an unlisted action is a write: a new mutation must never
// inherit read. Only search, whose every action reads, keeps a read fallback.
const TOOL_FALLBACK: Record<string, ActionMeta> = {
  tasks: m(CapWrite, "task", "medium"),
  docs: m(CapWrite, "doc", "medium"),
  time: m(CapWrite, "time", "medium"),
  search: m(CapRead, "search", "low"),
  code: m(CapWrite, "code", "high"),
  templates: m(CapWrite, "template", "medium"),
  validate: m(CapRead, "runtime", "low"),
  memory: m(CapWrite, "memory", "medium"),
  decision: m(CapWrite, "decision", "medium"),
  project: m(CapAdmin, "runtime", "medium"),
};

const DEFAULT_META = m(CapRead, "runtime", "low");

/** ClassifyAction: the full tool.action key, then the tool default, then a safe read. */
export function classifyAction(tool: string, action: string): ActionMeta {
  return ACTION_REGISTRY[`${tool}.${action}`] ?? TOOL_FALLBACK[tool] ?? DEFAULT_META;
}

export function classifyValidateAction(fix: boolean): ActionMeta {
  return ACTION_REGISTRY[fix ? "validate.fix" : "validate.default"] as ActionMeta;
}

export const PresetReadOnly = "read-only";
export const PresetReadWrite = "read-write";
export const PresetReadWriteNoDelete = "read-write-no-delete";
export const PresetGenerateDryRun = "generate-dry-run";
export const DefaultPreset = PresetReadWriteNoDelete;

export interface PresetPolicy {
  name: string;
  allowed: Set<string>;
  denied: Set<string>;
  dryRunRequired: Set<string>;
  deleteRequiresDryRun: boolean;
}

const set = (...v: string[]): Set<string> => new Set(v);

const PRESETS: Record<string, PresetPolicy> = {
  [PresetReadOnly]: {
    name: PresetReadOnly,
    allowed: set(CapRead),
    denied: set(CapWrite, CapGenerate, CapArchive, CapDelete, CapAdmin),
    dryRunRequired: set(),
    deleteRequiresDryRun: false,
  },
  [PresetReadWrite]: {
    name: PresetReadWrite,
    allowed: set(CapRead, CapWrite, CapGenerate, CapArchive, CapDelete),
    denied: set(CapAdmin),
    dryRunRequired: set(),
    deleteRequiresDryRun: true,
  },
  [PresetReadWriteNoDelete]: {
    name: PresetReadWriteNoDelete,
    allowed: set(CapRead, CapWrite, CapGenerate, CapArchive),
    denied: set(CapDelete, CapAdmin),
    dryRunRequired: set(),
    deleteRequiresDryRun: false,
  },
  [PresetGenerateDryRun]: {
    name: PresetGenerateDryRun,
    allowed: set(CapRead),
    denied: set(CapWrite, CapDelete, CapAdmin, CapArchive),
    dryRunRequired: set(CapGenerate),
    deleteRequiresDryRun: false,
  },
};

export const getPresetPolicy = (name: string): PresetPolicy | undefined =>
  Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;

export function effectivePreset(cfg: PermissionConfig | undefined | null): string {
  return !cfg || !cfg.preset ? DefaultPreset : cfg.preset;
}

/** EffectivePolicy: an unknown preset falls back to the default for safety. */
export function effectivePolicy(cfg: PermissionConfig | undefined | null): PresetPolicy {
  return getPresetPolicy(effectivePreset(cfg)) ?? (PRESETS[DefaultPreset] as PresetPolicy);
}

export interface DenialPayload {
  denied: boolean;
  capability: string;
  target: string;
  reason: string;
  suggestion?: string;
  policyRef: { source: string; preset: string; configPath: string };
}

function suggestionFor(cap: string): string {
  switch (cap) {
    case CapDelete:
      return "Use archive instead, or update project permissions in config.json";
    case CapWrite:
      return "Update project permissions in config.json to allow write operations";
    case CapGenerate:
      return "Update project permissions in config.json to allow generate operations";
    case CapAdmin:
      return "Admin operations require explicit user action";
    default:
      return "Update project permissions in config.json";
  }
}

export function checkCapability(
  policy: PresetPolicy,
  meta: ActionMeta,
  dryRun: boolean,
): DenialPayload | undefined {
  const cap = meta.capability;
  const ref = { source: "project", preset: policy.name, configPath: "config.json#permissions" };
  const base = { denied: true, capability: cap, target: meta.target };
  if (policy.denied.has(cap)) {
    return {
      ...base,
      reason: `Policy '${policy.name}' does not allow ${cap} operations`,
      suggestion: suggestionFor(cap),
      policyRef: ref,
    };
  }
  if (policy.dryRunRequired.has(cap) && !dryRun) {
    return {
      ...base,
      reason: `Policy '${policy.name}' requires dryRun=true for ${cap} operations`,
      suggestion: "Set dryRun=true to preview the operation",
      policyRef: ref,
    };
  }
  if (policy.deleteRequiresDryRun && cap === CapDelete && !dryRun) {
    return {
      ...base,
      reason: `Policy '${policy.name}' requires dryRun=true before delete operations`,
      suggestion: "Set dryRun=true to preview the deletion first",
      policyRef: ref,
    };
  }
  return undefined;
}

// --- guard ------------------------------------------------------------------------------------

const isBootstrapAction = (tool: string, action: string): boolean =>
  ["project.set", "project.detect", "project.current", "project.status"].includes(
    `${tool}.${action}`,
  );

const LIFECYCLE_ACTIONS = new Set([
  "archive",
  "unarchive",
  "batch_archive",
  "batch_unarchive",
  "hard_delete",
]);

export const isPublicTaskLifecycleAction = (tool: string, action: string): boolean =>
  tool === "tasks" && LIFECYCLE_ACTIONS.has(action);

/** archive-style previews: execute defaults to false. */
export function lifecyclePreview(action: string, args: Args): boolean {
  switch (action) {
    case "archive":
    case "unarchive":
    case "batch_archive":
    case "batch_unarchive":
      return args.execute !== true;
    default:
      return false;
  }
}

export const isDryRun = (args: Args): boolean => args.dryRun === true;

function explicitDeleteConfirmation(args: Args): boolean {
  const reason = typeof args.reason === "string" ? args.reason : "";
  return args.confirmed === true && goTrimSpace(reason) !== "";
}

import { goTrimSpace } from "../storage/core/util.ts";

/**
 * The guard middleware (Pass 1: capability and target, no IO). Returns the denial result, or
 * undefined when the call may proceed to the handler.
 */
export function guard(
  req: CallToolRequest,
  loadConfig: () => PermissionConfig | undefined | null,
): CallToolResult | undefined {
  const tool = req.name;
  const args = req.args ?? {};
  const action = typeof args.action === "string" ? args.action : "";
  if (isBootstrapAction(tool, action)) return undefined;
  if (isPublicTaskLifecycleAction(tool, action)) return undefined;

  const meta =
    tool === "validate" ? classifyValidateAction(args.fix === true) : classifyAction(tool, action);
  const policy = effectivePolicy(loadConfig());
  const dryRun = isDryRun(args) || lifecyclePreview(action, args);
  const confirmedDelete = meta.capability === CapDelete && explicitDeleteConfirmation(args);
  const denial = checkCapability(policy, meta, dryRun || confirmedDelete);
  if (denial) return errorResult(marshalIndent(denial));
  return undefined;
}
