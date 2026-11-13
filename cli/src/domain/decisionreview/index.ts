// Port of internal/decisionreview: duplicate/conflict review, evidence verification, acceptance and
// resolution of System Decision candidates. A library: no CLI imports.
import {
  type DecisionEntry,
  type DecisionReviewMatch,
  decisionCandidateForReviewInbox,
  decisionCurrentForDefaultRetrieval,
  decisionRef,
  validDecisionId,
  validDecisionStatus,
} from "../../models/decision.ts";
import type { SearchEnvironment } from "../../search/config.ts";
import { searchWithRuntime } from "../../search/runtime.ts";
import { stableSort } from "../../search/text.ts";
import type { Storage } from "../../storage/adapters.ts";
import { canonicalDecisionHash } from "./hash.ts";
import {
  type DecisionMatch,
  type DecisionReviewResult,
  decisionJson,
  decisionResultJson,
} from "./shape.ts";
import {
  appendUnique,
  firstNonEmpty,
  goFields,
  goTrimSpace,
  normalizedText,
  normalizeStringSlice,
  significantTokenSet,
  tokenSimilarity,
  truncate,
} from "./text.ts";

export { decisionReviewIsStale } from "./hash.ts";
export type { DecisionMatch, DecisionReviewResult };
export { canonicalDecisionHash, decisionJson, decisionResultJson };

export const RESULT_CREATED = "created";
export const RESULT_REVIEW_REQUIRED = "review_required";
export const RESULT_RESOLVED = "resolved";

export const RESOLUTION_SUPERSEDE_EXISTING = "supersede_existing";
export const RESOLUTION_CREATE_DRAFT = "create_draft";
export const RESOLUTION_LINK_AS_RELATED = "link_as_related";
export const RESOLUTION_REJECT_NEW = "reject_new";
export const RESOLUTION_ACCEPT_NEW = "accept_new";

export const MATCH_DUPLICATE = "duplicate";
export const MATCH_CONFLICT = "conflict";

const DEFAULT_REVIEW_LIMIT = 5;
const DEFAULT_REVIEW_THRESHOLD = 0.72;

export const ALLOWED_RESOLUTIONS: readonly string[] = [
  RESOLUTION_SUPERSEDE_EXISTING,
  RESOLUTION_LINK_AS_RELATED,
  RESOLUTION_REJECT_NEW,
];
export const READY_RESOLUTIONS: readonly string[] = [RESOLUTION_ACCEPT_NEW, RESOLUTION_REJECT_NEW];

export type SemanticSearchFunc = (
  candidate: DecisionEntry,
  limit: number,
) => Promise<DecisionMatch[]> | DecisionMatch[];

export interface DecisionReviewOptions {
  now?: () => Date;
  semanticSearch?: SemanticSearchFunc;
  /** Enables the default semantic leg (searchWithRuntime, mode semantic, type decision). */
  searchEnv?: SearchEnvironment;
  reviewThreshold?: number;
  reviewLimit?: number;
}

export interface AddOptions {
  skipReview?: boolean;
  status?: string;
}

export interface AcceptOptions {
  supersedes?: string[];
}

export interface ResolveOptions {
  candidateId?: string;
  resolution: string;
  targetId?: string;
  replacementId?: string;
  status?: string;
}

export function cloneDecision(entry: DecisionEntry): DecisionEntry;
export function cloneDecision(entry: DecisionEntry | null | undefined): DecisionEntry | undefined;
export function cloneDecision(entry: DecisionEntry | null | undefined): DecisionEntry | undefined {
  if (!entry) return undefined;
  const clone: DecisionEntry = { ...entry };
  for (const k of [
    "supersedes",
    "supersededBy",
    "tags",
    "sources",
    "relatedDocs",
    "relatedTasks",
    "verification",
    "reviewBlockers",
    "reviewAllowedResolutions",
  ] as const) {
    const v = entry[k];
    if (v) clone[k] = [...v];
  }
  if (entry.reviewMatches) {
    clone.reviewMatches = entry.reviewMatches.map((m) => ({
      ...m,
      ...(m.matchedBy ? { matchedBy: [...m.matchedBy] } : {}),
      ...(m.tags ? { tags: [...m.tags] } : {}),
    }));
  }
  return clone;
}

export class DecisionReviewService {
  constructor(
    readonly storage: Storage,
    private readonly opts: DecisionReviewOptions = {},
  ) {}

  async add(candidate: DecisionEntry, opts: AddOptions = {}): Promise<DecisionReviewResult> {
    const entry = this.normalizeCandidate(candidate, opts.status ?? "");
    if (entry.status !== "draft") {
      throw new Error(
        "new System Decisions must start as draft; create the draft, link evidence, then accept it after verification",
      );
    }
    if (opts.skipReview) return this.create(entry, RESULT_CREATED, "");
    const { matches, blockers } = await this.evaluateCandidate(entry);
    this.applyReviewMetadata(entry, matches, blockers);
    const created = await this.create(entry, RESULT_CREATED, "");
    if (entry.reviewState !== "needs_resolution") return created;
    return {
      status: RESULT_REVIEW_REQUIRED,
      candidate: entry,
      decision: entry,
      matches,
      allowedResolutions: [...(entry.reviewAllowedResolutions ?? [])],
      changedIds: [entry.id],
    };
  }

  /**
   * Accept verifies linked evidence and transitions a draft to current guidance. Replacement
   * supersession, when requested, is committed with the acceptance.
   */
  async accept(idIn: string, opts: AcceptOptions = {}): Promise<DecisionReviewResult> {
    const id = goTrimSpace(idIn);
    if (id === "") throw new Error("decision ID is required");
    const entry = this.storage.decisions.get(id);
    const supersedes = opts.supersedes ?? [];
    if (entry.status === "draft") {
      const { matches, blockers } = await this.evaluateCandidate(entry);
      this.applyReviewMetadata(entry, matches, blockers);
      await this.storage.decisions.update(entry);
      if (blockers.length > 0) throw new Error(blockers[0] as string);
      if (matches.length > 0 && supersedes.length === 0) {
        throw new Error(`decision "${id}" needs duplicate/conflict resolution before acceptance`);
      }
    }
    const evidence = this.verificationEvidence(entry);
    const { accepted, replaced } = await this.storage.decisions.accept(
      id,
      evidence,
      supersedes,
      this.now(),
    );
    const changed = [accepted.id, ...replaced.map((r) => r.id)];
    const result: DecisionReviewResult = {
      status: RESULT_RESOLVED,
      decision: accepted,
      current: accepted,
      supersededDecisions: replaced,
      changedIds: changed,
    };
    if (replaced.length > 0) result.superseded = replaced[0] as DecisionEntry;
    return result;
  }

  async review(candidate: DecisionEntry): Promise<DecisionReviewResult | undefined> {
    const entry = this.normalizeCandidate(candidate, "");
    let matches: DecisionMatch[] = [];
    try {
      matches = matches.concat(await this.semanticMatches(entry));
    } catch {
      // best effort
    }
    matches = matches.concat(this.lexicalMatches(entry));
    matches = mergeMatches(matches, this.threshold());
    if (matches.length === 0) return undefined;
    if (matches.length > this.limit()) matches = matches.slice(0, this.limit());
    return {
      status: RESULT_REVIEW_REQUIRED,
      candidate: entry,
      matches,
      allowedResolutions: [...ALLOWED_RESOLUTIONS],
    };
  }

  /** ReviewCandidates: unresolved persisted candidates; legacy migration drafts stay out. */
  async reviewCandidates(): Promise<DecisionEntry[]> {
    const entries = this.storage.decisions.list();
    const candidates: DecisionEntry[] = [];
    for (let entry of entries) {
      if (entry.status !== "draft" || (entry.tags ?? []).includes("legacy-memory-migration")) {
        continue;
      }
      if (!entry.reviewState) entry = await this.refreshCandidate(entry.id);
      if (decisionCandidateForReviewInbox(entry)) candidates.push(entry);
    }
    return candidates;
  }

  /** RefreshCandidate reruns review checks after evidence or provenance change and persists them. */
  async refreshCandidate(id: string): Promise<DecisionEntry> {
    const entry = this.storage.decisions.get(goTrimSpace(id));
    if (entry.status !== "draft") return entry;
    const { matches, blockers } = await this.evaluateCandidate(entry);
    this.applyReviewMetadata(entry, matches, blockers);
    await this.storage.decisions.update(entry);
    return this.storage.decisions.get(entry.id);
  }

  private async evaluateCandidate(
    entry: DecisionEntry,
  ): Promise<{ matches: DecisionMatch[]; blockers: string[] }> {
    const review = await this.review(entry);
    const matches = review?.matches ? [...review.matches] : [];
    const blockers: string[] = [];
    try {
      this.verificationEvidence(entry);
    } catch (err) {
      blockers.push(candidateRepairGuidance((err as Error).message));
    }
    return { matches, blockers };
  }

  private applyReviewMetadata(
    entry: DecisionEntry,
    matches: DecisionMatch[],
    blockers: string[],
  ): void {
    const uniqueBlockers = appendUnique(undefined, ...blockers);
    if (uniqueBlockers.length > 0) entry.reviewBlockers = uniqueBlockers;
    else delete entry.reviewBlockers;
    const persisted = persistedMatches(matches);
    if (persisted.length > 0) entry.reviewMatches = persisted;
    else delete entry.reviewMatches;
    delete entry.reviewAllowedResolutions;
    if (uniqueBlockers.length > 0) {
      entry.reviewState = "needs_evidence";
    } else if (persisted.length > 0) {
      entry.reviewState = "needs_resolution";
      entry.reviewAllowedResolutions = [...ALLOWED_RESOLUTIONS];
    } else {
      entry.reviewState = "ready_for_review";
      entry.reviewAllowedResolutions = [...READY_RESOLUTIONS];
    }
    entry.reviewEvaluatedAt = this.now().toISOString();
    // Which state was judged, not only when. The hash excludes the review fields, so writing the
    // review cannot invalidate its own watermark.
    entry.reviewEvaluatedHash = canonicalDecisionHash(entry);
  }

  async resolve(
    candidate: DecisionEntry | undefined,
    opts: ResolveOptions,
  ): Promise<DecisionReviewResult> {
    if (!opts.resolution) throw new Error("resolution is required");
    let candidateId = goTrimSpace(opts.candidateId ?? "");
    if (candidateId === "" && candidate && candidate.id !== "" && candidate.id !== opts.targetId) {
      try {
        this.storage.decisions.get(candidate.id);
        candidateId = candidate.id;
      } catch {
        // not persisted: resolve it as a fresh candidate
      }
    }
    if (candidateId !== "") return this.resolvePersistedCandidate(candidateId, opts);
    switch (opts.resolution) {
      case RESOLUTION_SUPERSEDE_EXISTING:
        return this.supersedeExisting(candidate, opts);
      case RESOLUTION_CREATE_DRAFT: {
        const input = cloneDecision(candidate) ?? blankDecision();
        input.status = "draft";
        const entry = this.normalizeCandidate(input, "draft");
        return this.create(entry, RESULT_RESOLVED, opts.resolution);
      }
      case RESOLUTION_LINK_AS_RELATED:
        return this.linkAsRelated(candidate, opts);
      case RESOLUTION_REJECT_NEW: {
        const input = cloneDecision(candidate) ?? blankDecision();
        input.status = "rejected";
        const entry = this.normalizeCandidate(input, "rejected");
        return this.create(entry, RESULT_RESOLVED, opts.resolution);
      }
      default:
        throw new Error(`unsupported decision review resolution: ${opts.resolution}`);
    }
  }

  private async resolvePersistedCandidate(
    candidateId: string,
    opts: ResolveOptions,
  ): Promise<DecisionReviewResult> {
    let candidate = this.storage.decisions.get(candidateId);
    switch (opts.resolution) {
      case RESOLUTION_ACCEPT_NEW: {
        if (candidate.status === "accepted") return this.accept(candidate.id, {});
        candidate = await this.refreshCandidate(candidate.id);
        if (candidate.reviewState !== "ready_for_review") {
          throw new Error(
            `decision "${candidate.id}" is ${candidate.reviewState ?? ""}; accept_new requires ready_for_review`,
          );
        }
        const result = await this.accept(candidate.id, {});
        result.resolution = opts.resolution;
        return result;
      }
      case RESOLUTION_SUPERSEDE_EXISTING: {
        if (goTrimSpace(opts.targetId ?? "") === "") {
          throw new Error(`targetId is required for ${opts.resolution}`);
        }
        const target = opts.targetId as string;
        if (candidate.status === "accepted")
          return this.accept(candidate.id, { supersedes: [target] });
        candidate = await this.refreshCandidate(candidate.id);
        if (candidate.reviewState === "needs_evidence") {
          throw new Error(`decision "${candidate.id}" needs evidence before replacement`);
        }
        if (!candidateHasReviewMatch(candidate, target)) {
          throw new Error(
            `target decision "${target}" is not a persisted review match for candidate "${candidate.id}"`,
          );
        }
        const result = await this.accept(candidate.id, { supersedes: [target] });
        result.resolution = opts.resolution;
        return result;
      }
      case RESOLUTION_LINK_AS_RELATED: {
        if (goTrimSpace(opts.targetId ?? "") === "") {
          throw new Error(`targetId is required for ${opts.resolution}`);
        }
        const target = opts.targetId as string;
        if (candidate.status === "draft") {
          candidate = await this.refreshCandidate(candidate.id);
          if (candidate.reviewState === "needs_evidence") {
            throw new Error(`decision "${candidate.id}" needs evidence before linking`);
          }
          if (!candidateHasReviewMatch(candidate, target)) {
            throw new Error(
              `target decision "${target}" is not a persisted review match for candidate "${candidate.id}"`,
            );
          }
        }
        const { candidate: rejected, target: current } =
          await this.storage.decisions.linkCandidateToCurrent(candidate.id, target, this.now());
        return {
          status: RESULT_RESOLVED,
          resolution: opts.resolution,
          decision: rejected,
          current,
          changedIds: [rejected.id, current.id],
        };
      }
      case RESOLUTION_REJECT_NEW: {
        const rejected = await this.storage.decisions.rejectCandidate(candidate.id, this.now());
        return {
          status: RESULT_RESOLVED,
          resolution: opts.resolution,
          decision: rejected,
          changedIds: [rejected.id],
        };
      }
      case RESOLUTION_CREATE_DRAFT:
        if (candidate.status !== "draft") {
          throw new Error(`decision "${candidate.id}" is not a draft candidate`);
        }
        return {
          status: RESULT_RESOLVED,
          resolution: opts.resolution,
          decision: candidate,
          changedIds: [candidate.id],
          pendingVerification: true,
        };
      default:
        throw new Error(`unsupported decision review resolution: ${opts.resolution}`);
    }
  }

  private async supersedeExisting(
    candidate: DecisionEntry | undefined,
    opts: ResolveOptions,
  ): Promise<DecisionReviewResult> {
    if (!opts.targetId) throw new Error(`targetId is required for ${opts.resolution}`);
    this.storage.decisions.get(opts.targetId);
    const newId = opts.replacementId ?? "";
    if (newId === "") {
      const input = cloneDecision(candidate) ?? blankDecision();
      if (input.id === opts.targetId) input.id = "";
      input.status = "draft";
      const entry = this.normalizeCandidate(input, "draft");
      const created = await this.create(entry, RESULT_RESOLVED, opts.resolution);
      try {
        created.current = this.storage.decisions.get(opts.targetId);
      } catch {
        // Go ignores the error here too
      }
      created.pendingVerification = true;
      return created;
    }
    this.storage.decisions.get(newId);
    const { old, next } = await this.storage.decisions.supersede(opts.targetId, newId);
    return {
      status: RESULT_RESOLVED,
      resolution: opts.resolution,
      decision: next,
      superseded: old,
      current: next,
      changedIds: [old.id, next.id],
    };
  }

  /** verificationEvidence: the evidence list for acceptance, or the reason there is none. */
  verificationEvidence(entry: DecisionEntry | undefined): string[] {
    if (!entry) throw new Error("decision is required");
    const sources = entry.sources ?? [];
    if (sources.length === 0) {
      throw new Error(`decision "${entry.id}" needs at least one source before acceptance`);
    }
    const evidence: string[] = [];
    for (const raw of sources) {
      const source = goTrimSpace(raw);
      if (source === "") continue;
      this.verifySource(source);
      evidence.push(`source:${source}`);
    }
    let taskIds = normalizeRelatedTaskIds(entry.relatedTasks ?? []);
    for (const relatedDoc of entry.relatedDocs ?? []) {
      const path = normalizeRelatedDocPath(relatedDoc);
      if (path === "") continue;
      try {
        this.storage.docs.get(path);
      } catch (err) {
        throw new Error(`related doc "${path}" is not readable: ${(err as Error).message}`, {
          cause: err,
        });
      }
      if (path.startsWith("specs/")) {
        let tasks: ReturnType<Storage["tasks"]["listAll"]>;
        try {
          tasks = this.storage.tasks.listAll();
        } catch (err) {
          throw new Error(`list tasks linked to spec "${path}": ${(err as Error).message}`, {
            cause: err,
          });
        }
        for (const task of tasks) {
          if (task.spec === path) taskIds = appendUnique(taskIds, task.id);
        }
      }
    }
    if (taskIds.length === 0) {
      throw new Error(
        `decision "${entry.id}" needs at least one linked task or a spec with linked tasks before acceptance`,
      );
    }
    for (const taskId of taskIds) {
      let task: ReturnType<Storage["tasks"]["get"]>;
      try {
        task = this.storage.tasks.get(taskId);
      } catch (err) {
        throw new Error(`linked task "${taskId}" is not readable: ${(err as Error).message}`, {
          cause: err,
        });
      }
      if (task.status !== "done") {
        throw new Error(
          `linked task "${taskId}" is "${task.status}"; all linked tasks must be done before accepting decision "${entry.id}"`,
        );
      }
      for (const criterion of task.acceptanceCriteria ?? []) {
        if (!criterion.completed) {
          throw new Error(`linked task "${taskId}" has unchecked acceptance criteria`);
        }
      }
      evidence.push(`task:@task-${taskId}:done`);
    }
    return appendUnique(undefined, ...evidence);
  }

  private verifySource(source: string): void {
    const unreadable = (err: unknown): never => {
      throw new Error(`source "${source}" is not readable: ${(err as Error).message}`, {
        cause: err,
      });
    };
    try {
      if (source.startsWith("@doc/")) {
        this.storage.docs.get(normalizeRelatedDocPath(source));
      } else if (source.startsWith("@task-")) {
        this.storage.tasks.get(source.slice("@task-".length));
      } else if (source.startsWith("@task/")) {
        this.storage.tasks.get(source.slice("@task/".length));
      } else if (source.startsWith("@decision/")) {
        this.storage.decisions.get(source.slice("@decision/".length));
      }
    } catch (err) {
      unreadable(err);
    }
  }

  private async linkAsRelated(
    candidate: DecisionEntry | undefined,
    opts: ResolveOptions,
  ): Promise<DecisionReviewResult> {
    if (!opts.targetId) throw new Error(`targetId is required for ${opts.resolution}`);
    this.storage.decisions.get(opts.targetId);
    const input = cloneDecision(candidate) ?? blankDecision();
    if (input.id === opts.targetId) input.id = "";
    input.status = "draft";
    input.sources = appendUnique(input.sources, decisionRef(opts.targetId));
    const entry = this.normalizeCandidate(input, "draft");
    return this.create(entry, RESULT_RESOLVED, opts.resolution);
  }

  private async create(
    entry: DecisionEntry,
    status: "created" | "resolved",
    resolution: string,
  ): Promise<DecisionReviewResult> {
    await this.storage.decisions.create(entry, { now: this.now() });
    const result: DecisionReviewResult = { status, decision: entry, changedIds: [entry.id] };
    if (resolution) result.resolution = resolution;
    return result;
  }

  private normalizeCandidate(
    candidate: DecisionEntry | undefined,
    defaultStatus: string,
  ): DecisionEntry {
    const entry = cloneDecision(candidate) ?? blankDecision();
    entry.id = goTrimSpace(entry.id);
    entry.title = goTrimSpace(entry.title);
    entry.status = firstNonEmpty(entry.status, defaultStatus);
    entry.content = goTrimSpace(entry.content ?? "");
    entry.context = goTrimSpace(entry.context ?? "");
    entry.decision = goTrimSpace(entry.decision ?? "");
    entry.alternativesConsidered = goTrimSpace(entry.alternativesConsidered ?? "");
    entry.consequences = goTrimSpace(entry.consequences ?? "");
    entry.tags = normalizeStringSlice(entry.tags);
    entry.sources = normalizeStringSlice(entry.sources);
    entry.relatedDocs = normalizeStringSlice(entry.relatedDocs);
    entry.relatedTasks = normalizeStringSlice(entry.relatedTasks);
    if (entry.title === "") throw new Error("decision title is required");
    if (entry.status === "") entry.status = "draft";
    if (!validDecisionStatus(entry.status)) {
      throw new Error(`invalid decision status: "${entry.status}"`);
    }
    if (entry.id !== "" && !validDecisionId(entry.id)) {
      throw new Error(`invalid decision ID: "${entry.id}"`);
    }
    return entry;
  }

  private async semanticMatches(candidate: DecisionEntry): Promise<DecisionMatch[]> {
    if (this.opts.semanticSearch) return this.opts.semanticSearch(candidate, this.limit());
    const env = this.opts.searchEnv;
    if (!env) return [];
    const response = await searchWithRuntime(this.storage, env, {
      query: candidateSearchText(candidate),
      type: "decision",
      mode: "semantic",
      limit: this.limit(),
    });
    const matches: DecisionMatch[] = [];
    for (const result of response.results) {
      if (result.id === "" || result.id === candidate.id) continue;
      if (result.type !== "decision" || result.score < this.threshold()) continue;
      let entry: DecisionEntry;
      try {
        entry = this.storage.decisions.get(result.id);
      } catch {
        continue;
      }
      if (!decisionCurrentForDefaultRetrieval(entry)) continue;
      matches.push(
        matchFromEntry(
          entry,
          result.score,
          MATCH_DUPLICATE,
          [...(result.matchedBy ?? [])],
          result.snippet ?? "",
        ),
      );
    }
    return matches;
  }

  private lexicalMatches(candidate: DecisionEntry): DecisionMatch[] {
    let entries: DecisionEntry[];
    try {
      entries = this.storage.decisions.list();
    } catch {
      return [];
    }
    const matches: DecisionMatch[] = [];
    for (const entry of entries) {
      if (entry.id === candidate.id || !decisionCurrentForDefaultRetrieval(entry)) continue;
      const [score, kind, reasons] = lexicalScore(candidate, entry);
      if (score < this.threshold()) continue;
      matches.push(matchFromEntry(entry, score, kind, reasons, candidateSnippet(entry)));
    }
    sortMatches(matches);
    return matches;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private threshold(): number {
    const t = this.opts.reviewThreshold;
    return t !== undefined && t > 0 ? t : DEFAULT_REVIEW_THRESHOLD;
  }

  private limit(): number {
    const l = this.opts.reviewLimit;
    return l !== undefined && l > 0 ? l : DEFAULT_REVIEW_LIMIT;
  }
}

function blankDecision(): DecisionEntry {
  return { id: "", title: "", status: "", createdAt: "", updatedAt: "" };
}

function candidateRepairGuidance(messageIn: string): string {
  const message = goTrimSpace(messageIn).replaceAll('decision ""', "candidate");
  if (message === "") {
    return "Review evidence could not be verified; add a readable source and completed linked task, then retry.";
  }
  return message;
}

function persistedMatches(matches: DecisionMatch[]): DecisionReviewMatch[] {
  return matches.map((match) => {
    const out: DecisionReviewMatch = { id: match.id, title: match.title, score: match.score };
    if (match.status) out.status = match.status;
    if (match.hash) out.hash = match.hash;
    if (match.kind) out.kind = match.kind;
    if (match.matchedBy && match.matchedBy.length > 0) out.matchedBy = [...match.matchedBy];
    const snippet = goFields(match.snippet ?? "").join(" ");
    if (snippet !== "") out.snippet = snippet;
    if (match.tags && match.tags.length > 0) out.tags = [...match.tags];
    return out;
  });
}

function candidateHasReviewMatch(candidate: DecisionEntry, targetId: string): boolean {
  return (candidate.reviewMatches ?? []).some((m) => m.id === targetId);
}

export function normalizeRelatedTaskIds(values: readonly string[]): string[] {
  let result: string[] = [];
  for (const raw of values) {
    let value = goTrimSpace(raw);
    for (const prefix of ["@task-", "@task/", "task-"]) {
      if (value.startsWith(prefix)) value = value.slice(prefix.length);
    }
    if (value !== "") result = appendUnique(result, value);
  }
  return result;
}

export function normalizeRelatedDocPath(raw: string): string {
  let value = goTrimSpace(raw);
  if (value.startsWith("@doc/")) value = value.slice("@doc/".length);
  if (value.endsWith(".md")) value = value.slice(0, -".md".length);
  return value.startsWith("/") ? value.slice(1) : value;
}

export function decisionBodyText(entry: DecisionEntry | undefined): string {
  if (!entry) return "";
  return goTrimSpace(
    [
      entry.decision ?? "",
      entry.context ?? "",
      entry.alternativesConsidered ?? "",
      entry.consequences ?? "",
      entry.content ?? "",
    ].join("\n"),
  );
}

export function candidateSearchText(entry: DecisionEntry | undefined): string {
  if (!entry) return "";
  return goTrimSpace(
    [
      entry.title,
      (entry.tags ?? []).join(" "),
      (entry.sources ?? []).join(" "),
      (entry.relatedDocs ?? []).join(" "),
      (entry.relatedTasks ?? []).join(" "),
      decisionBodyText(entry),
    ].join("\n"),
  );
}

function candidateSnippet(entry: DecisionEntry): string {
  const text = decisionBodyText(entry);
  return text !== "" ? text : entry.title;
}

/**
 * lexicalScore. Go builds the label order from a map iteration, which is random; the order here is
 * fixed (title tokens, decision tokens, combined) so matchedBy is reproducible.
 */
export function lexicalScore(
  candidate: DecisionEntry,
  existing: DecisionEntry,
): [number, string, string[]] {
  const candidateTitle = normalizedText(candidate.title);
  const existingTitle = normalizedText(existing.title);
  const candidateDecision = normalizedText(decisionBodyText(candidate));
  const existingDecision = normalizedText(decisionBodyText(existing));
  const candidateAll = normalizedText(candidateSearchText(candidate));
  const existingAll = normalizedText(candidateSearchText(existing));

  let best = 0;
  let kind = "";
  const reasons: string[] = [];
  if (candidateTitle !== "" && candidateTitle === existingTitle) {
    best = Math.max(best, 0.98);
    kind = MATCH_DUPLICATE;
    reasons.push("lexical:title");
  }
  if (candidateDecision !== "" && candidateDecision === existingDecision) {
    best = Math.max(best, 1.0);
    kind = MATCH_DUPLICATE;
    reasons.push("lexical:decision");
  }
  const scored: [string, number][] = [
    ["lexical:title_tokens", tokenSimilarity(candidateTitle, existingTitle)],
    ["lexical:decision_tokens", tokenSimilarity(candidateDecision, existingDecision)],
    ["lexical:combined", tokenSimilarity(candidateAll, existingAll)],
  ];
  for (const [label, score] of scored) {
    if (score > best) best = score;
    if (score >= DEFAULT_REVIEW_THRESHOLD) {
      if (kind === "") kind = MATCH_DUPLICATE;
      reasons.push(label);
    }
  }
  const overlap = conflictTopicOverlap(candidateTitle, existingTitle);
  if (overlap.ok) {
    best = Math.max(best, 0.82 + Math.min((overlap.count - 2) * 0.03, 0.09));
    if (kind === "") kind = MATCH_CONFLICT;
    reasons.push("lexical:conflict_topic");
  }
  if (kind === "" && best >= DEFAULT_REVIEW_THRESHOLD) {
    kind = MATCH_DUPLICATE;
    reasons.push("lexical");
  }
  return [best, kind, reasons];
}

function conflictTopicOverlap(a: string, b: string): { count: number; ok: boolean } {
  const left = significantTokenSet(a);
  const right = significantTokenSet(b);
  if (left.size === 0 || right.size === 0) return { count: 0, ok: false };
  let count = 0;
  for (const token of left) if (right.has(token)) count++;
  return { count, ok: count >= 2 && goTrimSpace(a) !== goTrimSpace(b) };
}

export function mergeMatches(matches: DecisionMatch[], threshold: number): DecisionMatch[] {
  const byId = new Map<string, DecisionMatch>();
  for (const raw of matches) {
    if (raw.id === "" || raw.score < threshold) continue;
    const existing = byId.get(raw.id);
    const match = { ...raw };
    if (!existing || match.score > existing.score) {
      match.matchedBy = appendUnique(existing?.matchedBy, ...(match.matchedBy ?? []));
      byId.set(match.id, match);
      continue;
    }
    existing.matchedBy = appendUnique(existing.matchedBy, ...(match.matchedBy ?? []));
  }
  const merged = [...byId.values()];
  sortMatches(merged);
  return merged;
}

export function sortMatches(matches: DecisionMatch[]): void {
  stableSort(matches, (a, b) => {
    if (a.score !== b.score) return a.score > b.score;
    return a.title < b.title;
  });
}

function matchFromEntry(
  entry: DecisionEntry,
  score: number,
  kind: string,
  matchedBy: string[],
  snippet: string,
): DecisionMatch {
  const trimmed = goTrimSpace(snippet);
  return {
    id: entry.id,
    title: entry.title,
    ...(entry.status ? { status: entry.status } : {}),
    score,
    ...(kind ? { kind } : {}),
    ...(matchedBy.length > 0 ? { matchedBy } : {}),
    ...(trimmed !== "" ? { snippet: truncate(trimmed, 220) } : {}),
    ...(entry.tags && entry.tags.length > 0 ? { tags: [...entry.tags] } : {}),
    hash: canonicalDecisionHash(entry),
  };
}
