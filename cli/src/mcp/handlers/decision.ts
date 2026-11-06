// Port of internal/mcp/handlers/decision.go.

import { goQuote } from "../../cli/core/gofmt.ts";
import {
  applyResultJson,
  DecisionMigrationService,
  previewReportJson,
  rollbackResultJson,
} from "../../domain/decisionmigration/index.ts";
import {
  DecisionReviewService,
  decisionJson,
  decisionResultJson,
} from "../../domain/decisionreview/index.ts";
import {
  type DecisionEntry,
  decisionCurrentForDefaultRetrieval,
  validDecisionStatus,
} from "../../models/decision.ts";
import {
  boolArg,
  containsString,
  errFailed,
  errNotFound,
  noProjectError,
  stringArg,
  stringSliceArg,
} from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import type { McpState, Project } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "create":
      return create(state, req);
    case "list":
      return list(state, req);
    case "get":
      return get(state, req);
    case "link":
      return link(state, req);
    case "accept":
      return accept(state, req);
    case "supersede":
      return supersede(state, req);
    case "review_inbox":
      return reviewInbox(state);
    case "resolve":
      return resolve(state, req);
    case "migration_preview":
      return migrationPreview(state);
    case "migration_apply":
      return migrationApply(state, req);
    case "migration_rollback":
      return migrationRollback(state, req);
    default:
      return errorResult(`unknown decision action: ${a.value}`);
  }
}

const result = (v: unknown): CallToolResult => textResult(marshalIndent(v));

async function searchEnv() {
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  return buildSearchEnvironment();
}

async function review(project: Project): Promise<DecisionReviewService> {
  return new DecisionReviewService(project.storage, { searchEnv: await searchEnv() });
}

async function indexDecision(project: Project, id: string): Promise<void> {
  const { bestEffortIndexDecision } = await import("../../runtime/index/best-effort.ts");
  try {
    bestEffortIndexDecision(project.storage, id);
  } catch {
    // best effort
  }
}

async function reviewInbox(state: McpState): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  try {
    const candidates = await (await review(project)).reviewCandidates();
    return result(candidates.map(decisionJson));
  } catch (e) {
    return errFailed("list Decision review inbox", e);
  }
}

async function migrationService(project: Project): Promise<DecisionMigrationService> {
  return new DecisionMigrationService(project.storage, {
    decisionReview: { searchEnv: await searchEnv() },
  });
}

async function migrationPreview(state: McpState): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  try {
    return result(previewReportJson((await migrationService(project)).preview()));
  } catch (e) {
    return errFailed("preview Decision Memory migration", e);
  }
}

async function migrationApply(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [memoryId] = stringArg(args, "memoryId");
  const [resolution] = stringArg(args, "migrationResolution");
  const [decisionId] = stringArg(args, "decisionId");
  const [targetMemoryId] = stringArg(args, "targetMemoryId");
  const [category] = stringArg(args, "category");
  const [reason] = stringArg(args, "reason");
  const [relatedDocs] = stringSliceArg(args, "relatedDocs");
  const [relatedTasks] = stringSliceArg(args, "relatedTasks");
  let applied: Awaited<ReturnType<DecisionMigrationService["apply"]>>;
  try {
    applied = await (await migrationService(project)).apply([
      {
        memoryId,
        resolution,
        decisionId,
        targetMemoryId,
        category,
        reason,
        relatedDocs,
        relatedTasks,
        acceptVerified: boolArg(args, "acceptVerified"),
      },
    ]);
  } catch (e) {
    return errFailed("apply Decision Memory migration", e);
  }
  for (const item of applied.results)
    if (item.decisionId) await indexDecision(project, item.decisionId);
  return result(applyResultJson(applied));
}

async function migrationRollback(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const [memoryId] = stringArg(argsOf(req), "memoryId");
  try {
    const r = await (await migrationService(project)).rollback(memoryId);
    if (r.decisionId) await indexDecision(project, r.decisionId);
    return result(rollbackResultJson(r));
  } catch (e) {
    return errFailed("rollback Decision Memory migration", e);
  }
}

function inputFromArgs(args: Record<string, unknown>, withId: boolean): DecisionEntry {
  const [id] = stringArg(args, "id");
  const [title] = stringArg(args, "title");
  const [status] = stringArg(args, "status");
  const [body] = stringArg(args, "body");
  const [context] = stringArg(args, "context");
  const [decision] = stringArg(args, "decision");
  const [alternatives] = stringArg(args, "alternatives");
  const [consequences] = stringArg(args, "consequences");
  const [tags] = stringSliceArg(args, "tags");
  const [sources] = stringSliceArg(args, "sources");
  const [relatedDocs] = stringSliceArg(args, "relatedDocs");
  const [relatedTasks] = stringSliceArg(args, "relatedTasks");
  const e: DecisionEntry = { id: withId ? id : "", title, status, createdAt: "", updatedAt: "" };
  if (tags.length > 0) e.tags = tags;
  if (sources.length > 0) e.sources = sources;
  if (relatedDocs.length > 0) e.relatedDocs = relatedDocs;
  if (relatedTasks.length > 0) e.relatedTasks = relatedTasks;
  if (body !== "") e.content = body;
  if (context !== "") e.context = context;
  if (decision !== "") e.decision = decision;
  if (alternatives !== "") e.alternativesConsidered = alternatives;
  if (consequences !== "") e.consequences = consequences;
  return e;
}

async function create(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [title] = stringArg(args, "title");
  if (title === "") return errorResult("title is required");
  const [status] = stringArg(args, "status");
  if (status !== "" && !validDecisionStatus(status)) {
    return errorResult("status must be a valid decision status");
  }
  let r: Awaited<ReturnType<DecisionReviewService["add"]>>;
  try {
    r = await (await review(project)).add(inputFromArgs(args, false), {});
  } catch (e) {
    return errFailed("create decision", e);
  }
  if (r.status === "review_required") {
    if (r.candidate) await indexDecision(project, r.candidate.id);
    return result(decisionResultJson(r));
  }
  if (r.decision) await indexDecision(project, r.decision.id);
  return result(r.decision ? decisionJson(r.decision) : null);
}

async function list(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [status] = stringArg(args, "status");
  const [tag] = stringArg(args, "tag");
  const includeAll = boolArg(args, "includeAll");
  if (status !== "" && !validDecisionStatus(status)) {
    return errorResult("status must be a valid decision status");
  }
  let decisions: DecisionEntry[];
  try {
    decisions = project.storage.decisions.list();
  } catch (e) {
    return errFailed("list decisions", e);
  }
  // A nil Go slice stays nil through the filter and marshals as null, not [].
  const wasNil = decisions.length === 0;
  const filtered = decisions.filter((d) => {
    if (status !== "") {
      if (d.status !== status) return false;
    } else if (!includeAll && !decisionCurrentForDefaultRetrieval(d)) {
      return false;
    }
    return tag === "" || containsString(d.tags, tag);
  });
  return result(wasNil ? null : filtered.map(decisionJson));
}

async function get(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  try {
    return result(decisionJson(project.storage.decisions.get(id.value)));
  } catch {
    return errNotFound("decision", new Error(`decision ${goQuote(id.value)} not found`));
  }
}

async function link(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const args = argsOf(req);
  const [docs] = stringSliceArg(args, "relatedDocs");
  const [tasks] = stringSliceArg(args, "relatedTasks");
  const [sources] = stringSliceArg(args, "sources");
  let decision: DecisionEntry;
  try {
    decision = await project.storage.decisions.link(id.value, docs, tasks, sources);
  } catch (e) {
    return errFailed("link decision", e);
  }
  if (decision.status === "draft") {
    try {
      decision = await (await review(project)).refreshCandidate(decision.id);
    } catch (e) {
      return errFailed("refresh Decision candidate", e);
    }
  }
  await indexDecision(project, decision.id);
  return result(decisionJson(decision));
}

async function supersede(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  let [oldId] = stringArg(args, "oldId");
  if (oldId === "") [oldId] = stringArg(args, "id");
  const [newId] = stringArg(args, "newId");
  try {
    const pair = await project.storage.decisions.supersede(oldId, newId);
    await indexDecision(project, pair.old.id);
    await indexDecision(project, pair.next.id);
    return result(goMap({ superseded: decisionJson(pair.old), current: decisionJson(pair.next) }));
  } catch (e) {
    return errFailed("supersede decision", e);
  }
}

async function accept(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const [supersedes] = stringSliceArg(argsOf(req), "supersedes");
  try {
    const r = await (await review(project)).accept(id.value, { supersedes });
    for (const changed of r.changedIds ?? []) await indexDecision(project, changed);
    return result(decisionResultJson(r));
  } catch (e) {
    return errFailed("accept decision", e);
  }
}

async function resolve(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [resolution, ok] = stringArg(args, "resolution");
  if (!ok || resolution === "") return errorResult("resolution is required");
  const [targetId] = stringArg(args, "targetId");
  const [candidateId] = stringArg(args, "candidateId");
  const [replacementId] = stringArg(args, "replacementId");
  const [status] = stringArg(args, "status");
  try {
    const r = await (await review(project)).resolve(inputFromArgs(args, true), {
      candidateId,
      resolution,
      targetId,
      replacementId,
      status,
    });
    for (const id of r.changedIds ?? []) await indexDecision(project, id);
    return result(decisionResultJson(r));
  } catch (e) {
    return errFailed("resolve decision review", e);
  }
}
