// `knowns decision`: port of internal/cli/decision.go.
import {
  type ApplyResult,
  applyResultJson,
  DecisionMigrationService,
  ALLOWED_RESOLUTIONS as MIGRATION_RESOLUTIONS,
  MigrationApplyError,
  type PreviewReport,
  previewReportJson,
  type RollbackResult,
  rollbackResultJson,
} from "../../domain/decisionmigration/index.ts";
import {
  type DecisionReviewResult,
  DecisionReviewService,
  decisionJson,
  decisionResultJson,
  decisionReviewIsStale,
} from "../../domain/decisionreview/index.ts";
import {
  type DecisionEntry,
  decisionCurrentForDefaultRetrieval,
  decisionRef,
  validDecisionStatus,
} from "../../models/decision.ts";
import type { Storage } from "../../storage/adapters.ts";
import { arbitraryArgs, exactArgs, minimumNArgs, noArgs } from "../core/args.ts";
import { type CommandContext, defineCommand, type FlagSpec } from "../core/define.ts";
import {
  renderSeparator,
  renderSuccess,
  renderWarning,
  StyleBold,
  StyleDim,
  StyleID,
} from "../core/plainoutput.ts";
import {
  bestEffortIndexDecision,
  containsTag,
  openStorage,
  searchEnvironment,
} from "./memory-support.ts";

const goPad = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - [...s].length));

function byteCut(s: string, n: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= n) return s;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, n));
}

function reviewService(ctx: CommandContext, storage: Storage): DecisionReviewService {
  return new DecisionReviewService(storage, { searchEnv: searchEnvironment(ctx) });
}

function decisionPlain(decision: DecisionEntry): string {
  let b = `ID: ${decision.id}\n`;
  b += `TITLE: ${decision.title}\n`;
  b += `STATUS: ${decision.status}\n`;
  if (decision.supersedes?.length) b += `SUPERSEDES: ${decision.supersedes.join(", ")}\n`;
  if (decision.supersededBy?.length) b += `SUPERSEDED_BY: ${decision.supersededBy.join(", ")}\n`;
  if (decision.sources?.length) b += `SOURCES: ${decision.sources.join(", ")}\n`;
  if (decision.relatedDocs?.length) b += `RELATED_DOCS: ${decision.relatedDocs.join(", ")}\n`;
  if (decision.relatedTasks?.length) b += `RELATED_TASKS: ${decision.relatedTasks.join(", ")}\n`;
  if (decision.tags?.length) b += `TAGS: ${decision.tags.join(", ")}\n`;
  if (decision.reviewState) b += `REVIEW_STATE: ${decision.reviewState}\n`;
  if (decisionReviewIsStale(decision)) {
    b += "REVIEW_STALE: the decision changed after this review; re-run it\n";
  }
  for (const blocker of decision.reviewBlockers ?? []) b += `REVIEW_BLOCKER: ${blocker}\n`;
  b += `REF: ${decisionRef(decision.id)}\n\n`;
  if (decision.content) b += `${decision.content}\n`;
  return b;
}

function reviewRequiredText(result: DecisionReviewResult): string {
  let b = `${renderWarning("Decision review required: similar or conflicting current decisions already exist.")}\n`;
  for (const match of result.matches ?? []) {
    b += `DECISION: ${match.id}\n`;
    b += `  TITLE: ${match.title}\n`;
    if (match.status) b += `  STATUS: ${match.status}\n`;
    if (match.kind) b += `  KIND: ${match.kind}\n`;
    b += `  SCORE: ${match.score.toFixed(2)}\n`;
    if (match.matchedBy?.length) b += `  MATCHED_BY: ${match.matchedBy.join(", ")}\n`;
    b += "\n";
  }
  b += `Allowed resolutions: ${(result.allowedResolutions ?? []).join(", ")}\n`;
  if (result.candidate) {
    b += `Persisted candidate: ${result.candidate.id}\n`;
    b += `Run \`knowns decision resolve <resolution> ${result.candidate.id}\` with --target when required.\n`;
  }
  return b;
}

function renderDecisionList(decisions: DecisionEntry[]): string {
  let b = `  ${StyleBold.render(goPad("ID", 22))}  ${StyleBold.render(goPad("TITLE", 36))}  ${StyleBold.render("STATUS")}\n`;
  b += `  ${renderSeparator(76)}\n`;
  for (const decision of decisions) {
    let title = decision.title;
    if (Buffer.byteLength(title) > 34) title = `${byteCut(title, 31)}...`;
    b += `  ${StyleID.render(goPad(decision.id, 22))}  ${goPad(title, 36)}  ${decision.status}\n`;
  }
  if (decisions.length === 0) b += `${StyleDim.render("No decisions found.")}\n`;
  return b;
}

async function runDecisionGet(ctx: CommandContext, id: string): Promise<void> {
  const storage = await openStorage(ctx);
  let decision: DecisionEntry;
  try {
    decision = storage.decisions.get(id);
  } catch {
    throw new Error(`decision "${id}" not found`);
  }
  if (ctx.json) {
    ctx.printJSON(decisionJson(decision));
    return;
  }
  ctx.printPaged(decisionPlain(decision));
}

/** addDecisionInputFlags. */
function inputFlags(includeStatus: boolean): FlagSpec[] {
  const flags: FlagSpec[] = [];
  if (includeStatus) {
    flags.push({
      type: "string",
      name: "status",
      usage: "Decision status; new System Decisions must be draft",
      default: "",
    });
  }
  flags.push(
    { type: "stringArray", name: "tag", shorthand: "t", usage: "Decision tag (repeatable)" },
    { type: "stringArray", name: "source", usage: "Source reference (repeatable)" },
    { type: "stringArray", name: "doc", usage: "Related doc path (repeatable)" },
    { type: "stringArray", name: "task", usage: "Related task ID (repeatable)" },
    { type: "string", name: "body", usage: "Full markdown decision body", default: "" },
    { type: "string", name: "context", usage: "Context section body", default: "" },
    { type: "string", name: "decision", usage: "Decision section body", default: "" },
    {
      type: "string",
      name: "alternatives",
      usage: "Alternatives Considered section body",
      default: "",
    },
    { type: "string", name: "consequences", usage: "Consequences section body", default: "" },
  );
  return flags;
}

function decisionFromFlags(ctx: CommandContext, title: string): DecisionEntry {
  const status = ctx.flags.string("status");
  if (status !== "" && !validDecisionStatus(status)) {
    throw new Error(`invalid decision status: "${status}"`);
  }
  const entry: DecisionEntry = { id: "", title, status, createdAt: "", updatedAt: "" };
  const list = (k: "tags" | "sources" | "relatedDocs" | "relatedTasks", v: string[]) => {
    if (v.length > 0) entry[k] = [...v];
  };
  list("tags", ctx.flags.strings("tag"));
  list("sources", ctx.flags.strings("source"));
  list("relatedDocs", ctx.flags.strings("doc"));
  list("relatedTasks", ctx.flags.strings("task"));
  const text = (
    k: "content" | "context" | "decision" | "alternativesConsidered" | "consequences",
    v: string,
  ) => {
    if (v !== "") entry[k] = v;
  };
  text("content", ctx.flags.string("body"));
  text("context", ctx.flags.string("context"));
  text("decision", ctx.flags.string("decision"));
  text("alternativesConsidered", ctx.flags.string("alternatives"));
  text("consequences", ctx.flags.string("consequences"));
  return entry;
}

const decisionCreate = defineCommand({
  use: "create <title>",
  short: "Create a decision record",
  args: minimumNArgs(1),
  flags: inputFlags(true),
  async run(ctx) {
    const title = ctx.args.join(" ");
    const storage = await openStorage(ctx);
    const input = decisionFromFlags(ctx, title);
    let result: DecisionReviewResult;
    try {
      result = await reviewService(ctx, storage).add(input, {});
    } catch (e) {
      throw new Error(`create decision: ${(e as Error).message}`, { cause: e });
    }
    if (result.status === "review_required") {
      if (ctx.json) {
        ctx.printJSON(decisionResultJson(result));
        return;
      }
      ctx.printPaged(reviewRequiredText(result));
      return;
    }
    const decision = result.decision as DecisionEntry;
    await bestEffortIndexDecision(storage, decision.id);
    if (ctx.json) {
      ctx.printJSON(decisionJson(decision));
      return;
    }
    if (ctx.plain) {
      ctx.printPaged(decisionPlain(decision));
      return;
    }
    ctx.print(
      `${renderSuccess(`Created decision: ${decision.id} (${decision.title}, status: ${decision.status})`)}\n`,
    );
  },
});

const decisionList = defineCommand({
  use: "list",
  short: "List decision records",
  flags: [
    { type: "string", name: "status", usage: "Filter by decision status", default: "" },
    {
      type: "bool",
      name: "all-statuses",
      usage: "Include draft, superseded, rejected, and archived decisions",
      default: false,
    },
    { type: "string", name: "tag", usage: "Filter by tag", default: "" },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const status = ctx.flags.string("status");
    const includeAll = ctx.flags.bool("all-statuses");
    const tag = ctx.flags.string("tag");
    if (status !== "" && !validDecisionStatus(status)) {
      throw new Error(`invalid decision status: "${status}"`);
    }
    let decisions: DecisionEntry[];
    try {
      decisions = storage.decisions.list();
    } catch (e) {
      throw new Error(`list decisions: ${(e as Error).message}`, { cause: e });
    }
    // A nil Go slice stays nil through the filter and marshals as null, not [].
    const wasNil = decisions.length === 0;
    decisions = decisions.filter((d) => {
      if (status !== "") {
        if (d.status !== status) return false;
      } else if (!includeAll && !decisionCurrentForDefaultRetrieval(d)) {
        return false;
      }
      return tag === "" || containsTag(d.tags, tag);
    });
    if (ctx.json) {
      ctx.printJSON(wasNil ? null : decisions.map(decisionJson));
      return;
    }
    if (ctx.plain) {
      let b = "";
      for (const d of decisions) {
        b += `DECISION: ${d.id}\n`;
        b += `  TITLE: ${d.title}\n`;
        b += `  STATUS: ${d.status}\n`;
        if (d.tags?.length) b += `  TAGS: ${d.tags.join(", ")}\n`;
        b += "\n";
      }
      if (b === "") b = "No decisions found\n";
      ctx.printPaged(b);
      return;
    }
    ctx.print(renderDecisionList(decisions));
  },
});

const decisionInbox = defineCommand({
  use: "inbox",
  short: "List unresolved persisted Decision candidates",
  args: noArgs,
  async run(ctx) {
    const storage = await openStorage(ctx);
    let candidates: DecisionEntry[];
    try {
      candidates = await reviewService(ctx, storage).reviewCandidates();
    } catch (e) {
      throw new Error(`list Decision review inbox: ${(e as Error).message}`, { cause: e });
    }
    if (ctx.json) {
      ctx.printJSON(candidates.map(decisionJson));
      return;
    }
    let b = "";
    for (const c of candidates) {
      b += `CANDIDATE: ${c.id}\n`;
      b += `  TITLE: ${c.title}\n`;
      b += `  REVIEW_STATE: ${c.reviewState ?? ""}\n`;
      if (decisionReviewIsStale(c)) {
        b += "  REVIEW_STALE: the decision changed after this review; re-run it\n";
      }
      for (const blocker of c.reviewBlockers ?? []) b += `  BLOCKER: ${blocker}\n`;
      b += "\n";
    }
    if (b === "") b = "No unresolved Decision candidates\n";
    ctx.printPaged(b);
  },
});

const decisionGet = defineCommand({
  use: "get <id>",
  short: "View a decision record",
  args: exactArgs(1),
  run: (ctx) => runDecisionGet(ctx, ctx.args[0] as string),
});

const decisionLink = defineCommand({
  use: "link <id>",
  short: "Link docs, tasks, or sources to a decision",
  args: exactArgs(1),
  flags: [
    { type: "stringArray", name: "doc", usage: "Related doc path (repeatable)" },
    { type: "stringArray", name: "task", usage: "Related task ID (repeatable)" },
    { type: "stringArray", name: "source", usage: "Source reference (repeatable)" },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    let decision: DecisionEntry;
    try {
      decision = await storage.decisions.link(
        ctx.args[0] as string,
        ctx.flags.strings("doc"),
        ctx.flags.strings("task"),
        ctx.flags.strings("source"),
      );
    } catch (e) {
      throw new Error(`link decision: ${(e as Error).message}`, { cause: e });
    }
    if (decision.status === "draft") {
      try {
        decision = await reviewService(ctx, storage).refreshCandidate(decision.id);
      } catch (e) {
        throw new Error(`refresh Decision candidate: ${(e as Error).message}`, { cause: e });
      }
    }
    await bestEffortIndexDecision(storage, decision.id);
    if (ctx.json) {
      ctx.printJSON(decisionJson(decision));
      return;
    }
    ctx.print(`${renderSuccess(`Linked decision: ${decision.id}`)}\n`);
  },
});

const decisionSupersede = defineCommand({
  use: "supersede <old-id> <new-id>",
  short: "Mark one decision as superseded by another",
  args: exactArgs(2),
  async run(ctx) {
    const storage = await openStorage(ctx);
    let pair: { old: DecisionEntry; next: DecisionEntry };
    try {
      pair = await storage.decisions.supersede(ctx.args[0] as string, ctx.args[1] as string);
    } catch (e) {
      throw new Error(`supersede decision: ${(e as Error).message}`, { cause: e });
    }
    await bestEffortIndexDecision(storage, pair.old.id);
    await bestEffortIndexDecision(storage, pair.next.id);
    if (ctx.json) {
      // Go marshals a map[string]any: keys sorted.
      ctx.printJSON({ current: decisionJson(pair.next), superseded: decisionJson(pair.old) });
      return;
    }
    ctx.print(`${renderSuccess(`Decision ${pair.old.id} superseded by ${pair.next.id}`)}\n`);
  },
});

const decisionAccept = defineCommand({
  use: "accept <id>",
  short: "Accept a verified draft decision",
  args: exactArgs(1),
  flags: [
    {
      type: "stringArray",
      name: "supersede",
      usage: "Current decision ID replaced on acceptance (repeatable)",
    },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    let result: DecisionReviewResult;
    try {
      result = await reviewService(ctx, storage).accept(ctx.args[0] as string, {
        supersedes: ctx.flags.strings("supersede"),
      });
    } catch (e) {
      throw new Error(`accept decision: ${(e as Error).message}`, { cause: e });
    }
    for (const id of result.changedIds ?? []) await bestEffortIndexDecision(storage, id);
    if (ctx.json) {
      ctx.printJSON(decisionResultJson(result));
      return;
    }
    ctx.print(
      `${renderSuccess(`Accepted verified decision: ${(result.decision as DecisionEntry).id}`)}\n`,
    );
  },
});

const decisionResolve = defineCommand({
  use: "resolve <resolution> <candidate-id>",
  short: "Resolve a persisted System Decision candidate",
  long: "Resolve a persisted candidate with accept_new, link_as_related, reject_new, or supersede_existing. Link and replace require --target.",
  args: exactArgs(2),
  flags: [
    {
      type: "string",
      name: "target",
      usage: "Existing Decision ID required by link_as_related or supersede_existing",
      default: "",
    },
    {
      type: "string",
      name: "replacement-id",
      usage: "Existing verified replacement Decision ID for supersede_existing",
      default: "",
    },
  ],
  async run(ctx) {
    const resolution = ctx.args[0] as string;
    const candidateId = ctx.args[1] as string;
    const storage = await openStorage(ctx);
    let result: DecisionReviewResult;
    try {
      result = await reviewService(ctx, storage).resolve(undefined, {
        candidateId,
        resolution,
        targetId: ctx.flags.string("target"),
        replacementId: ctx.flags.string("replacement-id"),
      });
    } catch (e) {
      throw new Error(`resolve decision review: ${(e as Error).message}`, { cause: e });
    }
    for (const id of result.changedIds ?? []) await bestEffortIndexDecision(storage, id);
    if (ctx.json) {
      ctx.printJSON(decisionResultJson(result));
      return;
    }
    const decision = result.decision ?? result.current;
    if (ctx.plain && decision) {
      ctx.printPaged(decisionPlain(decision));
      return;
    }
    if (decision) {
      ctx.print(
        `${renderSuccess(`Resolved Decision review with ${resolution}: ${decision.id}`)}\n`,
      );
      return;
    }
    ctx.print(`${renderSuccess(`Resolved Decision review with ${resolution}`)}\n`);
  },
});

const migratePreview = defineCommand({
  use: "preview",
  short: "Preview legacy Decision Memory candidates without writing",
  args: noArgs,
  async run(ctx) {
    const storage = await openStorage(ctx);
    let report: PreviewReport;
    try {
      report = new DecisionMigrationService(storage).preview();
    } catch (e) {
      throw new Error(`preview Decision Memory migration: ${(e as Error).message}`, { cause: e });
    }
    if (ctx.json) {
      ctx.printJSON(previewReportJson(report));
      return;
    }
    let b = `Legacy Decision Memories: ${report.counts.total} (high-noise: ${report.counts.highNoise}, duplicate members: ${report.counts.duplicate}, source issues: ${report.counts.withIssue})\n\n`;
    for (const c of report.candidates) {
      b += `MEMORY: ${c.memoryId}\n`;
      b += `  TITLE: ${c.title}\n`;
      b += `  LAYER: ${c.layer}\n`;
      b += `  STATUS: ${c.status}\n`;
      b += `  NOISE: ${c.noiseLikelihood}\n`;
      if (c.duplicateMembers?.length) {
        b += `  DUPLICATES: ${c.duplicateMembers.join(", ")} (${c.duplicateGroup ?? ""})\n`;
      }
      if (c.sources.length > 0) b += `  SOURCES: ${c.sources.join(", ")}\n`;
      if (c.sourceIssues?.length) b += `  SOURCE_ISSUES: ${c.sourceIssues.join(", ")}\n`;
      b += `  PROPOSED_RESOLUTION: ${c.proposedResolution}\n`;
      if (c.proposedDecisionId) b += `  PROPOSED_DECISION: ${c.proposedDecisionId}\n`;
      if (c.proposedTargetId) b += `  PROPOSED_TARGET: ${c.proposedTargetId}\n`;
      if (c.proposedCategory) b += `  PROPOSED_CATEGORY: ${c.proposedCategory}\n`;
      if (c.journalState) b += `  JOURNAL: ${c.journalState}\n`;
      b += "\n";
    }
    if (report.candidates.length === 0) b += "No legacy Decision Memories found.\n";
    ctx.printPaged(b);
  },
});

const migrateApply = defineCommand({
  use: "apply",
  short: "Apply one explicit reviewed migration resolution",
  args: noArgs,
  flags: [
    {
      type: "string",
      name: "memory",
      usage: "Legacy Decision Memory ID (required)",
      default: "",
      required: true,
    },
    {
      type: "string",
      name: "resolution",
      usage: `Reviewed resolution: ${MIGRATION_RESOLUTIONS.join(", ")}`,
      default: "",
      required: true,
    },
    {
      type: "string",
      name: "decision-id",
      usage: "Existing or explicit System Decision ID",
      default: "",
    },
    {
      type: "string",
      name: "target-memory",
      usage: "Migrated target Memory ID for duplicate consolidation",
      default: "",
    },
    {
      type: "string",
      name: "category",
      usage: "Non-decision Memory category for reclassification",
      default: "",
    },
    { type: "string", name: "reason", usage: "Reviewed archive/reject rationale", default: "" },
    {
      type: "stringArray",
      name: "doc",
      usage: "Related doc path for created/linked Decision (repeatable)",
    },
    {
      type: "stringArray",
      name: "task",
      usage: "Related completed task for verified acceptance (repeatable)",
    },
    {
      type: "bool",
      name: "accept-verified",
      usage: "Accept only if linked evidence passes System Decision verification",
      default: false,
    },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const service = new DecisionMigrationService(storage, {
      decisionReview: { searchEnv: searchEnvironment(ctx) },
    });
    const selection = {
      memoryId: ctx.flags.string("memory"),
      resolution: ctx.flags.string("resolution"),
      decisionId: ctx.flags.string("decision-id"),
      targetMemoryId: ctx.flags.string("target-memory"),
      category: ctx.flags.string("category"),
      reason: ctx.flags.string("reason"),
      relatedDocs: ctx.flags.strings("doc"),
      relatedTasks: ctx.flags.strings("task"),
      acceptVerified: ctx.flags.bool("accept-verified"),
    };
    let result: ApplyResult | undefined;
    let failure: Error | undefined;
    try {
      result = await service.apply([selection]);
    } catch (e) {
      failure = e as Error;
      if (e instanceof MigrationApplyError) result = e.result;
    }
    if (ctx.json && result) ctx.printJSON(applyResultJson(result));
    if (failure) {
      throw new Error(`apply Decision Memory migration: ${failure.message}`, { cause: failure });
    }
    for (const item of (result as ApplyResult).results) {
      if (item.decisionId) await bestEffortIndexDecision(storage, item.decisionId);
      if (!ctx.json) {
        ctx.print(
          `${renderSuccess(`Migrated memory ${item.memoryId} with ${item.resolution} (state: ${item.state}, legacy excluded: ${item.legacyExcluded})`)}\n`,
        );
      }
    }
  },
});

const migrateRollback = defineCommand({
  use: "rollback <memory-id>",
  short: "Roll back a reviewed legacy Decision Memory migration",
  args: exactArgs(1),
  async run(ctx) {
    const storage = await openStorage(ctx);
    let result: RollbackResult;
    try {
      result = await new DecisionMigrationService(storage).rollback(ctx.args[0] as string);
    } catch (e) {
      throw new Error(`rollback Decision Memory migration: ${(e as Error).message}`, { cause: e });
    }
    if (result.decisionId) await bestEffortIndexDecision(storage, result.decisionId);
    if (ctx.json) {
      ctx.printJSON(rollbackResultJson(result));
      return;
    }
    ctx.print(`${renderSuccess(`Rolled back Decision Memory migration for ${result.memoryId}`)}\n`);
  },
});

const decisionMigrate = defineCommand({
  use: "migrate",
  short: "Review and migrate legacy Decision Memories",
  long: "Preview legacy Decision Memories without writes, apply one explicit reviewed resolution, or roll back a prior migration.",
  subcommands: [migratePreview, migrateApply, migrateRollback],
});

export default defineCommand({
  use: "decision",
  short: "Manage System Decision records",
  long: "Create draft System Decisions, link evidence, verify acceptance, supersede current guidance, and migrate Legacy Decision Memories.",
  args: arbitraryArgs,
  async run(ctx) {
    if (ctx.args.length === 0) {
      ctx.cmd.help();
      return;
    }
    await runDecisionGet(ctx, ctx.args[0] as string);
  },
  subcommands: [
    decisionCreate,
    decisionList,
    decisionInbox,
    decisionGet,
    decisionLink,
    decisionSupersede,
    decisionAccept,
    decisionResolve,
    decisionMigrate,
  ],
});
