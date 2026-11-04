// Port of internal/validate/validate.go: shared validation for tasks, docs, memories and templates.
// The CLI `validate` command and (later) the MCP tool both call `run`. No CLI imports.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../../models/doc.ts";
import {
  MEMORY_LAYER_GLOBAL,
  type MemoryEntry,
  missingTrustMetadata,
  validMemoryConfidence,
  validMemoryLayer,
  validMemoryStatus,
} from "../../models/memory.ts";
import type { Task } from "../../models/task.ts";
import type { Template } from "../../models/template.ts";
import type { Storage } from "../../storage/adapters.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { Engine } from "../codegen/index.ts";
import { extract, parse } from "../references/references.ts";
import { goQuote } from "./go-quote.ts";

/** A single validation problem. Key order is Go's struct order. */
export interface Issue {
  level: string;
  code: string;
  message: string;
  entity?: string;
  fixed?: boolean;
}

export interface Result {
  issues: Issue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  valid: boolean;
}

export interface Options {
  /** "all" (default), "tasks", "docs", "templates", "sdd", "memory". */
  scope?: string;
  /** Validate a single entity (task ID, doc path, memory ID or template name). */
  entity?: string;
  /** Treat warnings as errors. */
  strict?: boolean;
  /** Auto-fix supported issues (only changes the severity of a broken template doc link). */
  fix?: boolean;
  /** Also validate the user-level global memory layer. */
  includeGlobalMemory?: boolean;
  /** Clock override for tests (default Date.now). */
  now?: () => number;
}

// Go's \s is [\t\n\f\r ]; spelled out because JS \s is wider.
const S = "[\\t\\n\\f\\r ]";
const LOCKED_DECISION_RE = new RegExp(`^${S}*-${S}*(D[1-9][0-9]*):${S}*\\S`, "gm");
const DECISION_COMPLIANCE_LINE_RE = new RegExp(
  `^${S}*Spec Decision Compliance:${S}*([^\\n]+)$`,
  "gmi",
);
const DECISION_COMPLIANCE_ITEM_RE = new RegExp(
  `^${S}*(D[1-9][0-9]*)${S}*=${S}*(pass|conflict)(?::${S}*([^\\n]+))?${S}*$`,
  "i",
);
const SYSTEM_DECISION_IMPACT_RE = new RegExp(`^${S}*-${S}*Impact:${S}*([^\\n]+)$`, "mi");

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "todo",
  "in-progress",
  "in-review",
  "done",
  "blocked",
  "on-hold",
  "urgent",
]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(["low", "medium", "high"]);

const MEMORY_CONTENT_MAX_RUNES = 12000;
const PROPOSED_MEMORY_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type IdSet = ReadonlySet<string>;

function isGoZero(t: string | undefined): boolean {
  return t === undefined || t === "" || t === "0001-01-01T00:00:00Z";
}

/** Run executes all validation checks according to opts. */
export function run(storage: Storage, opts: Options = {}): Result {
  const o: Options = { ...opts, scope: opts.scope ? opts.scope : "all" };
  const scope = o.scope ?? "all";
  const issues: Issue[] = [];

  const tryList = <T>(fn: () => T[]): T[] => {
    try {
      return fn();
    } catch {
      return [];
    }
  };
  // The reference universe spans archived tasks; only active tasks are re-validated.
  const tasks = tryList(() => storage.tasks.listActive());
  const allTasks = tryList(() => storage.tasks.listAll());
  const docs = tryList(() => storage.docs.list());

  const taskIDs = new Set(allTasks.map((t) => t.id));
  const docPaths = new Set(docs.map((d) => d.path));

  // Every layer is loaded so a Task or Doc may resolve a reference to a global memory.
  const memories = tryList(() => storage.memory.list(""));
  const memoryIDs = new Set(memories.map((m) => m.id));
  // Global memories are shared across projects; only validate them when asked.
  const projectMemories = memories.filter(
    (m) => m.layer !== MEMORY_LAYER_GLOBAL || o.includeGlobalMemory === true,
  );

  // Archived ancestors are included so a chain through the archive is still detected.
  const parentMap = new Map<string, string>();
  for (const t of allTasks) if (t.parent) parentMap.set(t.id, t.parent);

  const ctx: Ctx = { storage, taskIDs, docPaths, memoryIDs, now: o.now ?? Date.now };

  if (scope === "all" || scope === "tasks" || scope === "sdd") {
    for (const t of tasks) {
      if (o.entity && o.entity !== t.id) continue;
      issues.push(...validateTask(t, ctx, parentMap, o));
    }
  }

  if (scope === "all" || scope === "docs" || scope === "sdd") {
    for (const d of docs) {
      if (d.isImported) continue;
      if (o.entity && o.entity !== d.path) continue;
      let full: Doc;
      try {
        full = storage.docs.get(d.path);
      } catch (e) {
        issues.push({
          level: "error",
          code: "DOC_PARSE_ERROR",
          message: `Failed to parse doc: ${errMsg(e)}`,
          entity: d.path,
        });
        continue;
      }
      issues.push(...validateDoc(full, ctx));
      if (scope === "sdd") issues.push(...validateSpecDecisionContract(full));
    }
  }

  if (scope === "all" || scope === "memory") {
    for (const m of projectMemories) {
      if (o.entity && o.entity !== m.id) continue;
      issues.push(...validateMemory(m, ctx));
    }
  }

  if (scope === "all" || scope === "templates") {
    let templates: Template[] | undefined;
    try {
      templates = storage.templates.list();
    } catch (e) {
      issues.push({
        level: "error",
        code: "TEMPLATE_LIST_ERROR",
        message: `Failed to list templates: ${errMsg(e)}`,
      });
    }
    if (templates) {
      const engine = new Engine(storage.store.projectRoot);
      for (const tmpl of templates) {
        if (o.entity && o.entity !== tmpl.name) continue;
        issues.push(...validateTemplate(tmpl, engine, docPaths, o));
      }
    }
  }

  if (o.strict) {
    for (const iss of issues) if (iss.level === "warning") iss.level = "error";
  }

  const r: Result = { issues, errorCount: 0, warningCount: 0, infoCount: 0, valid: false };
  for (const iss of issues) {
    if (iss.level === "error") r.errorCount++;
    else if (iss.level === "warning") r.warningCount++;
    else if (iss.level === "info") r.infoCount++;
  }
  r.valid = r.errorCount === 0;
  return r;
}

interface Ctx {
  storage: Storage;
  taskIDs: IdSet;
  docPaths: IdSet;
  memoryIDs: IdSet;
  now: () => number;
}

/** time.Format("2006-01-02") keeps the zone the timestamp was parsed with, not UTC. */
function formatInOffsetOf(ms: number, rfc3339: string): string {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(rfc3339);
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
  return new Date(ms + offset).toISOString().slice(0, 10);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function issue(level: string, code: string, message: string, entity?: string): Issue {
  const out: Issue = { level, code, message };
  if (entity !== undefined && entity !== "") out.entity = entity;
  return out;
}

// ---------- Task validation ----------

function validateTask(
  t: Task,
  ctx: Ctx,
  parentMap: ReadonlyMap<string, string>,
  opts: Options,
): Issue[] {
  const issues: Issue[] = [];
  const { taskIDs, docPaths } = ctx;

  if (t.title === "") issues.push(issue("error", "TASK_NO_TITLE", "Task has no title", t.id));

  if (t.status === "") {
    issues.push(issue("warning", "TASK_NO_STATUS", "Task has no status", t.id));
  } else if (!VALID_STATUSES.has(t.status)) {
    issues.push(
      issue(
        "warning",
        "TASK_INVALID_STATUS",
        `Task has non-standard status: ${goQuote(t.status)}`,
        t.id,
      ),
    );
  }

  if (t.priority === "") {
    issues.push(issue("info", "TASK_NO_PRIORITY", "Task has no priority", t.id));
  } else if (!VALID_PRIORITIES.has(t.priority)) {
    issues.push(
      issue(
        "warning",
        "TASK_INVALID_PRIORITY",
        `Task has invalid priority: ${goQuote(t.priority)}`,
        t.id,
      ),
    );
  }

  const parent = t.parent ?? "";
  if (parent !== "" && !taskIDs.has(parent)) {
    issues.push(
      issue("error", "BROKEN_TASK_REF", `Parent task ${goQuote(parent)} not found`, t.id),
    );
  }
  if (parent !== "" && detectCircularParent(t.id, parentMap)) {
    issues.push(issue("error", "TASK_CIRCULAR_PARENT", "Circular parent chain detected", t.id));
  }

  const spec = t.spec ?? "";
  if (spec !== "" && !docPaths.has(spec)) {
    issues.push(issue("warning", "BROKEN_DOC_REF", `Spec doc ${goQuote(spec)} not found`, t.id));
  }

  if ((t.fulfills?.length ?? 0) > 0 && spec === "") {
    issues.push(
      issue("warning", "TASK_FULFILLS_NO_SPEC", "Task has fulfills but no linked spec", t.id),
    );
  }

  const labels = t.labels ?? [];
  if (labels.length > 1) {
    const seen = new Set<string>();
    for (const l of labels) {
      if (seen.has(l)) {
        issues.push(issue("info", "TASK_DUPLICATE_LABELS", `Duplicate label: ${goQuote(l)}`, t.id));
        break;
      }
      seen.add(l);
    }
  }

  const criteria = t.acceptanceCriteria ?? [];
  if (t.status === "done" && criteria.length > 0) {
    criteria.forEach((ac, i) => {
      if (!ac.completed) {
        issues.push(
          issue(
            "warning",
            "TASK_DONE_UNCHECKED_AC",
            `Task is done but AC #${i + 1} is not checked: ${ac.text}`,
            t.id,
          ),
        );
      }
    });
  }

  const checkText = `${t.description ?? ""} ${t.implementationPlan ?? ""} ${t.implementationNotes ?? ""}`;
  issues.push(...validateSemanticRefs(checkText, t.id, "warning", ctx));
  // @code/ references are checked against the AST index, which Go no longer has (a stub that
  // reports no index), so there is nothing to validate.

  if (opts.scope === "sdd") {
    if (spec !== "" && criteria.length === 0) {
      issues.push(
        issue(
          "warning",
          "SDD_NO_AC",
          "Task is linked to a spec but has no acceptance criteria",
          t.id,
        ),
      );
    }
    if (spec !== "") issues.push(...validateTaskSpecDecisionCompliance(t, ctx));
  }
  return issues;
}

function validateTaskSpecDecisionCompliance(task: Task, ctx: Ctx): Issue[] {
  const specPath = task.spec ?? "";
  let spec: Doc;
  try {
    spec = ctx.storage.docs.get(specPath);
  } catch (e) {
    return [
      issue(
        "error",
        "SDD_SPEC_DECISIONS_UNREADABLE",
        `Locked Decisions cannot be read from spec ${goQuote(specPath)}: ${errMsg(e)}`,
        task.id,
      ),
    ];
  }
  // The System Decision Impact section is the versioned opt-in for the Decision contract.
  if (markdownSectionContent(spec.content ?? "", "System Decision Impact") === undefined) return [];
  const { ids, sectionFound, issues: parseIssues } = specDecisionIDs(spec);
  const issues: Issue[] = [...parseIssues];
  if (!sectionFound || ids.length === 0) return issues;
  const checks = parseSpecDecisionCompliance(task.implementationNotes ?? "");
  const strictState = task.status === "in-review" || task.status === "done";
  const assessmentRequired = strictState || task.status === "in-progress";
  const missing: string[] = [];
  for (const id of ids) {
    const check = checks.get(id);
    if (!check) {
      missing.push(id);
      continue;
    }
    if (check.status === "conflict") {
      let note = goTrimSpace(check.note);
      if (note === "") note = "no conflict reason supplied";
      issues.push(
        issue(
          "error",
          "SDD_SPEC_DECISION_CONFLICT",
          `Spec Decision ${id} conflicts with task execution: ${note}`,
          task.id,
        ),
      );
    }
  }
  if (missing.length > 0 && assessmentRequired) {
    issues.push(
      issue(
        strictState ? "error" : "warning",
        "SDD_SPEC_DECISIONS_UNASSESSED",
        `Spec Decisions not assessed for linked spec ${goQuote(specPath)}: ${missing.join(", ")}; append \`Spec Decision Compliance: D1=pass, ...\``,
        task.id,
      ),
    );
  } else if (
    missing.length === 0 &&
    assessmentRequired &&
    !issues.some((i) => i.code === "SDD_SPEC_DECISION_CONFLICT")
  ) {
    issues.push(
      issue(
        "info",
        "SDD_SPEC_DECISIONS_COMPLIANT",
        `All ${ids.length} Spec Decisions from ${goQuote(specPath)} are assessed as compliant`,
        task.id,
      ),
    );
  }
  return issues;
}

interface ComplianceCheck {
  status: string;
  note: string;
}

function parseSpecDecisionCompliance(notes: string): Map<string, ComplianceCheck> {
  const checks = new Map<string, ComplianceCheck>();
  const matches = [...notes.matchAll(DECISION_COMPLIANCE_LINE_RE)];
  const last = matches[matches.length - 1];
  if (!last) return checks;
  for (const raw of (last[1] ?? "").split(/[,;]/)) {
    if (raw === "") continue; // strings.FieldsFunc drops empty fields
    const parts = DECISION_COMPLIANCE_ITEM_RE.exec(raw);
    if (!parts) continue;
    checks.set((parts[1] ?? "").toUpperCase(), {
      status: (parts[2] ?? "").toLowerCase(),
      note: goTrimSpace(parts[3] ?? ""),
    });
  }
  return checks;
}

function validateSpecDecisionContract(doc: Doc): Issue[] {
  if (!hasFoldedString(doc.tags ?? [], "spec")) return [];
  const { ids, sectionFound, issues } = specDecisionIDs(doc);
  if (!sectionFound) {
    issues.push(
      issue(
        "info",
        "SDD_LEGACY_SPEC_NO_LOCKED_DECISIONS",
        "Legacy spec has no Locked Decisions section; add stable D1/D2 IDs when it is next revised",
        doc.path,
      ),
    );
  } else if (ids.length > 0) {
    issues.push(
      issue(
        "info",
        "SDD_SPEC_DECISIONS_DECLARED",
        `Spec declares ${ids.length} stable Locked Decisions`,
        doc.path,
      ),
    );
  }

  const impact = markdownSectionContent(doc.content ?? "", "System Decision Impact");
  if (impact === undefined) {
    issues.push(
      issue(
        "info",
        "SDD_LEGACY_SPEC_NO_SYSTEM_DECISION_IMPACT",
        "Legacy spec has no System Decision Impact declaration; declare none, existing, draft new, or replacement when next revised",
        doc.path,
      ),
    );
    return issues;
  }
  const match = SYSTEM_DECISION_IMPACT_RE.exec(impact);
  const value = match?.[1];
  if (value === undefined || !validSystemDecisionImpact(value)) {
    issues.push(
      issue(
        "error",
        "SDD_SYSTEM_DECISION_IMPACT_INVALID",
        "System Decision Impact must declare one of: none, existing, draft new, replacement",
        doc.path,
      ),
    );
  } else {
    issues.push(
      issue(
        "info",
        "SDD_SYSTEM_DECISION_IMPACT_DECLARED",
        `System Decision impact is declared: ${goTrimSpace(value)}`,
        doc.path,
      ),
    );
  }
  return issues;
}

function specDecisionIDs(doc: Doc): { ids: string[]; sectionFound: boolean; issues: Issue[] } {
  const section = markdownSectionContent(doc.content ?? "", "Locked Decisions");
  if (section === undefined) return { ids: [], sectionFound: false, issues: [] };
  const ids: string[] = [];
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const match of section.matchAll(LOCKED_DECISION_RE)) {
    const id = (match[1] ?? "").toUpperCase();
    if (seen.has(id)) {
      issues.push(
        issue(
          "error",
          "SDD_SPEC_DECISION_DUPLICATE",
          `Locked Decision ID ${id} is duplicated`,
          doc.path,
        ),
      );
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    issues.push(
      issue(
        "warning",
        "SDD_SPEC_DECISIONS_EMPTY",
        "Locked Decisions section has no stable IDs such as D1 or D2",
        doc.path,
      ),
    );
  }
  return { ids, sectionFound: true, issues };
}

/** The body of the first heading named `title` (case-insensitive) up to the next heading of the same or higher level. */
export function markdownSectionContent(content: string, title: string): string | undefined {
  const lines = content.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = goTrimSpace(lines[i] ?? "");
    if (!trimmed.startsWith("#")) continue;
    const stripped = trimmed.replace(/^#+/, "");
    const hashes = trimmed.length - stripped.length;
    const heading = goTrimSpace(stripped);
    if (start < 0 && equalFold(heading, title)) {
      start = i + 1;
      level = hashes;
      continue;
    }
    if (start >= 0 && hashes <= level) return lines.slice(start, i).join("\n");
  }
  if (start >= 0) return lines.slice(start).join("\n");
  return undefined;
}

function equalFold(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();
}

function validSystemDecisionImpact(input: string): boolean {
  const value = goTrimSpace(input)
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  for (const allowed of ["none", "existing", "draft new", "replacement"]) {
    if (value === allowed || value.startsWith(`${allowed} `)) return true;
  }
  return false;
}

function hasFoldedString(values: readonly string[], target: string): boolean {
  return values.some((v) => equalFold(goTrimSpace(v), target));
}

/** Walks the parent chain and reports a cycle. */
function detectCircularParent(id: string, parentMap: ReadonlyMap<string, string>): boolean {
  const visited = new Set<string>([id]);
  let cur = parentMap.get(id) ?? "";
  while (cur !== "") {
    if (visited.has(cur)) return true;
    visited.add(cur);
    cur = parentMap.get(cur) ?? "";
  }
  return false;
}

// ---------- Doc validation ----------

function validateDoc(d: Doc, ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  if (d.title === "") issues.push(issue("warning", "DOC_NO_TITLE", "Doc has no title", d.path));
  if ((d.description ?? "") === "") {
    issues.push(issue("info", "DOC_NO_DESCRIPTION", "Doc has no description", d.path));
  }
  if ((d.content ?? "") === "") {
    issues.push(issue("info", "DOC_NO_CONTENT", "Doc has no content", d.path));
  }
  issues.push(...validateSemanticRefs(d.content ?? "", d.path, "info", ctx));
  return issues;
}

// ---------- Memory validation ----------

function validateMemory(m: MemoryEntry, ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  const content = m.content ?? "";

  if (m.title === "") {
    issues.push(issue("warning", "MEMORY_NO_TITLE", "Memory entry has no title", m.id));
  }
  if (content === "") {
    issues.push(issue("info", "MEMORY_NO_CONTENT", "Memory entry has no content", m.id));
  }
  if (!validMemoryLayer(m.layer)) {
    issues.push(
      issue(
        "error",
        "MEMORY_INVALID_LAYER",
        `Memory entry has invalid layer: ${goQuote(m.layer)}`,
        m.id,
      ),
    );
  }

  const status = m.status ?? "";
  if (status === "") {
    issues.push(
      issue("warning", "MEMORY_MISSING_STATUS", "Memory entry has no lifecycle status", m.id),
    );
  } else if (!validMemoryStatus(status)) {
    issues.push(
      issue(
        "warning",
        "MEMORY_INVALID_STATUS",
        `Memory entry has invalid lifecycle status: ${goQuote(status)}`,
        m.id,
      ),
    );
  }

  const confidence = m.confidence ?? "";
  if (confidence !== "" && !validMemoryConfidence(confidence)) {
    issues.push(
      issue(
        "warning",
        "MEMORY_INVALID_CONFIDENCE",
        `Memory entry has invalid confidence: ${goQuote(confidence)}`,
        m.id,
      ),
    );
  }

  const missing = missingTrustMetadata(m);
  if (missing.length > 0) {
    issues.push(
      issue(
        "warning",
        "MEMORY_MISSING_TRUST_METADATA",
        `Memory entry is missing trust metadata: ${missing.join(", ")}`,
        m.id,
      ),
    );
  }

  const now = ctx.now();
  if ((m.ttlDays ?? 0) > 0 && !isGoZero(m.lastVerified)) {
    const expiresAt = Date.parse(m.lastVerified ?? "") + (m.ttlDays ?? 0) * DAY_MS;
    if (now > expiresAt) {
      issues.push(
        issue(
          "warning",
          "MEMORY_TTL_EXPIRED",
          `Memory TTL expired on ${formatInOffsetOf(expiresAt, m.lastVerified ?? "")}`,
          m.id,
        ),
      );
    }
  }

  if ((m.sources?.length ?? 0) === 0) {
    issues.push(
      issue("warning", "MEMORY_MISSING_SOURCE", "Memory entry has no source references", m.id),
    );
  } else {
    issues.push(...validateMemorySources(m, ctx));
  }

  if ([...content].length > MEMORY_CONTENT_MAX_RUNES) {
    issues.push(
      issue(
        "warning",
        "MEMORY_CONTENT_TOO_LONG",
        `Memory content is longer than ${MEMORY_CONTENT_MAX_RUNES} characters`,
        m.id,
      ),
    );
  }

  if (status === "proposed") {
    const effective = !isGoZero(m.updatedAt) ? m.updatedAt : m.createdAt;
    if (
      !isGoZero(effective) &&
      Date.parse(effective ?? "") < now - PROPOSED_MEMORY_MAX_AGE_DAYS * DAY_MS
    ) {
      issues.push(
        issue(
          "warning",
          "MEMORY_OLD_PROPOSED",
          `Proposed memory is older than ${PROPOSED_MEMORY_MAX_AGE_DAYS} days`,
          m.id,
        ),
      );
    }
  }

  if (status === "merged" && (m.mergedInto ?? "") === "") {
    issues.push(
      issue(
        "warning",
        "MEMORY_MERGED_MISSING_TARGET",
        "Merged memory tombstone must point to mergedInto",
        m.id,
      ),
    );
  }
  if (status === "rejected" && (m.rejectedReason ?? "") === "") {
    issues.push(
      issue(
        "warning",
        "MEMORY_REJECTED_MISSING_REASON",
        "Rejected memory should record rejectedReason",
        m.id,
      ),
    );
  }

  issues.push(...validateSemanticRefs(content, m.id, "info", ctx));
  return issues;
}

function validateMemorySources(m: MemoryEntry, ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  for (const source of m.sources ?? []) {
    const ref = parseMemorySourceRef(source);
    if (!ref) continue;
    switch (ref.type) {
      case "task":
        if (!ctx.taskIDs.has(ref.target)) issues.push(brokenMemorySourceIssue(m.id, source));
        break;
      case "doc":
        if (!ctx.docPaths.has(ref.target)) issues.push(brokenMemorySourceIssue(m.id, source));
        break;
      case "memory":
        if (ref.target !== m.id && !ctx.memoryIDs.has(ref.target)) {
          issues.push(brokenMemorySourceIssue(m.id, source));
        }
        break;
      case "decision":
        issues.push(...validateMemoryDecisionSource(m.id, ref.target, source, ctx));
        break;
    }
  }
  return issues;
}

function parseMemorySourceRef(sourceInput: string): { type: string; target: string } | undefined {
  const source = goTrimSpace(sourceInput);
  if (source === "") return undefined;
  const ref = parse(source);
  if (ref) return { type: ref.type, target: ref.target };
  for (const [raw, type] of [
    ["@task/", "task"],
    ["@memory/", "memory"],
    ["@decision/", "decision"],
  ] as const) {
    if (!source.startsWith(raw)) continue;
    const target = goTrimSpace(source.slice(raw.length)).replace(/[.,;)]+$/, "");
    if (target === "") return undefined;
    return { type, target };
  }
  return undefined;
}

function brokenMemorySourceIssue(entityID: string, source: string): Issue {
  return issue(
    "warning",
    "MEMORY_BROKEN_SOURCE_REF",
    `Memory source reference is broken: ${goTrimSpace(source)}`,
    entityID,
  );
}

function validateMemoryDecisionSource(
  entityID: string,
  decisionID: string,
  source: string,
  ctx: Ctx,
): Issue[] {
  let decision: ReturnType<Storage["decisions"]["get"]>;
  try {
    decision = ctx.storage.decisions.get(decisionID);
  } catch {
    return [brokenMemorySourceIssue(entityID, source)];
  }
  if (decision.status === "superseded" || (decision.supersededBy?.length ?? 0) > 0) {
    return [
      issue(
        "warning",
        "MEMORY_SOURCE_DECISION_SUPERSEDED",
        `Memory source decision is superseded: ${goTrimSpace(source)}`,
        entityID,
      ),
    ];
  }
  return [];
}

// ---------- Template validation ----------

function validateTemplate(tmpl: Template, engine: Engine, docPaths: IdSet, opts: Options): Issue[] {
  const issues: Issue[] = [];
  const tmplPath = tmpl.path ?? "";

  if (tmpl.name === "") {
    issues.push(issue("error", "TEMPLATE_NO_NAME", "Template has no name", tmplPath));
  }
  const actions = tmpl.actions ?? [];
  if (actions.length === 0) {
    issues.push(
      issue("warning", "TEMPLATE_NO_ACTIONS", "Template has no actions defined", tmpl.name),
    );
  }

  actions.forEach((action, idx) => {
    const i = idx + 1;
    const template = action.template ?? "";
    if (template !== "") {
      const tplFile = join(tmplPath, template);
      let missing = false;
      try {
        statSync(tplFile);
      } catch (e) {
        missing = (e as NodeJS.ErrnoException).code === "ENOENT";
        if (!missing) return; // os.Stat failed some other way: Go goes on to ReadFile, which fails too
      }
      if (missing) {
        issues.push(
          issue(
            "error",
            "TEMPLATE_FILE_MISSING",
            `action[${i}] template file ${goQuote(template)} not found`,
            tmpl.name,
          ),
        );
      } else {
        let content: string | undefined;
        try {
          content = readFileSync(tplFile, "utf8");
        } catch {
          content = undefined;
        }
        if (content !== undefined) {
          try {
            engine.validateTemplate(content);
          } catch (e) {
            issues.push(
              issue(
                "error",
                "TEMPLATE_PARSE_ERROR",
                `action[${i}] ${goQuote(template)} parse error: ${errMsg(e)}`,
                tmpl.name,
              ),
            );
          }
        }
      }
    }
    const path = action.path ?? "";
    if (path !== "") {
      try {
        engine.validateTemplate(path);
      } catch (e) {
        issues.push(
          issue(
            "error",
            "TEMPLATE_PATH_ERROR",
            `action[${i}] path ${goQuote(path)} parse error: ${errMsg(e)}`,
            tmpl.name,
          ),
        );
      }
    }
  });

  const doc = tmpl.doc ?? "";
  if (doc !== "" && !docPaths.has(doc)) {
    issues.push(
      issue(
        opts.fix ? "info" : "warning",
        "BROKEN_DOC_REF",
        `Linked doc ${goQuote(doc)} not found`,
        tmpl.name,
      ),
    );
  }
  return issues;
}

// ---------- Semantic references ----------

function validateSemanticRefs(content: string, entityID: string, level: string, ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  for (const ref of extract(content)) {
    if (!ref.validRelation) {
      issues.push(
        issue(
          level,
          "INVALID_SEMANTIC_REF_RELATION",
          `Reference ${ref.raw} uses unsupported relation ${goQuote(ref.relation)}`,
          entityID,
        ),
      );
      continue;
    }
    switch (ref.type) {
      case "task":
        if (!ctx.taskIDs.has(ref.target)) {
          issues.push(
            issue(level, "BROKEN_TASK_REF", `Referenced task ${ref.canonical} not found`, entityID),
          );
        }
        break;
      case "doc":
        if (!ctx.docPaths.has(ref.target)) {
          issues.push(
            issue(level, "BROKEN_DOC_REF", `Referenced doc ${ref.canonical} not found`, entityID),
          );
        }
        break;
      case "memory":
        if (ref.target !== entityID && !ctx.memoryIDs.has(ref.target)) {
          issues.push(
            issue(
              level,
              "BROKEN_MEMORY_REF",
              `Referenced memory ${ref.canonical} not found`,
              entityID,
            ),
          );
        }
        break;
      case "decision":
        try {
          ctx.storage.decisions.get(ref.target);
        } catch {
          issues.push(
            issue(
              level,
              "BROKEN_DECISION_REF",
              `Referenced decision ${ref.canonical} not found`,
              entityID,
            ),
          );
        }
        break;
      case "template":
        try {
          ctx.storage.templates.get(ref.target);
        } catch {
          issues.push(
            issue(
              level,
              "BROKEN_TEMPLATE_REF",
              `Referenced template ${ref.canonical} not found`,
              entityID,
            ),
          );
        }
        break;
    }
  }
  return issues;
}

/** LooksLikeTaskID: true if `s` looks like a task ID rather than a doc path. */
export function looksLikeTaskID(s: string): boolean {
  if (Buffer.byteLength(s, "utf8") > 20) return false;
  if (s.includes("/")) return false;
  return /^[0-9a-zA-Z-]*$/.test(s);
}
