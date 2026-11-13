// Port of internal/decisionmigration: a reviewed, reversible bridge from the legacy Memory category
// "decision" to first-class System Decisions. A library: no CLI imports.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DecisionEntry,
  decisionRef,
  decisionSlug,
  validDecisionId,
} from "../../models/decision.ts";
import {
  isLegacyDecisionMemoryCategory,
  LEGACY_DECISION_MIGRATION_DECISION_KEY,
  LEGACY_DECISION_MIGRATION_ID_KEY,
  LEGACY_DECISION_MIGRATION_RESOLUTION_KEY,
  type MemoryEntry,
  memoryCurrentForDefaultRetrieval,
} from "../../models/memory.ts";
import type { Storage } from "../../storage/adapters.ts";
import { atomicWrite, goJsonStringify } from "../../storage/core/util.ts";
import { type DecisionReviewOptions, DecisionReviewService } from "../decisionreview/index.ts";
import { cloneMemory } from "../memoryreview/index.ts";
import {
  addedValues,
  compareStrings,
  firstNonEmpty,
  goFields,
  goTrimSpace,
  normalizeMigrationText,
  sortedUnique,
  sortStrings,
} from "./text.ts";
import {
  ALLOWED_RESOLUTIONS,
  type ApplyResult,
  applyResultJson,
  type Candidate,
  type ItemResult,
  JOURNAL_APPLIED,
  JOURNAL_FAILED,
  JOURNAL_PENDING,
  JOURNAL_ROLLED_BACK,
  JOURNAL_VERSION,
  type Journal,
  journalJson,
  NOISE_HIGH,
  NOISE_LOW,
  NOISE_MEDIUM,
  type PreviewReport,
  previewReportJson,
  RESOLUTION_ARCHIVE_NOISE,
  RESOLUTION_CONSOLIDATE_DUPLICATE,
  RESOLUTION_CREATE_DECISION,
  RESOLUTION_LEAVE_UNCHANGED,
  RESOLUTION_LINK_EXISTING,
  RESOLUTION_RECLASSIFY,
  RESOLUTION_REJECT_NOISE,
  type RollbackResult,
  rollbackResultJson,
  type Selection,
  validateSelection,
  validMigrationMemoryId,
} from "./types.ts";

export * from "./types.ts";
export { ALLOWED_RESOLUTIONS };

const INLINE_SOURCE = /@(doc|task|decision|memory)\/[A-Za-z0-9._/-]+/g;

/** Apply failed for one or more items (or the lock); `result` holds what was attempted. */
export class MigrationApplyError extends Error {
  constructor(
    message: string,
    readonly result: ApplyResult,
  ) {
    super(message);
    this.name = "MigrationApplyError";
  }
}

export interface DecisionMigrationOptions {
  now?: () => Date;
  /** Whether a current Decision hides its legacy Memory from default retrieval (default true). */
  currentDecisionConsumptionActive?: boolean;
  /** Options for the DecisionReviewService used by acceptVerified. */
  decisionReview?: DecisionReviewOptions;
  /** Test seams (service_test.go beforeStep / journalWriter). */
  beforeStep?: (memoryId: string, step: string) => void | Promise<void>;
  journalWriter?: (journal: Journal) => void | Promise<void>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function memoryReference(id: string): string {
  return `@memory/${id}`;
}

/** DecisionIDPrefix of a stored (UTC) timestamp, then DecisionSlug, with -2, -3 collision suffixes. */
function newDecisionIdAt(
  title: string,
  createdAt: string | undefined,
  exists: (id: string) => boolean,
): string {
  const parsed = createdAt ? new Date(createdAt) : undefined;
  const d =
    parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() > 1 ? parsed : undefined;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const prefix = d
    ? `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
    : (() => {
        const n = new Date();
        return `${p(n.getFullYear(), 4)}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
      })();
  const base = `${prefix}-${decisionSlug(title)}`;
  if (!exists(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
}

export class DecisionMigrationService {
  constructor(
    readonly storage: Storage,
    private readonly opts: DecisionMigrationOptions = {},
  ) {}

  private get consumptionActive(): boolean {
    return this.opts.currentDecisionConsumptionActive ?? true;
  }

  private now(): string {
    return (this.opts.now ? this.opts.now() : new Date()).toISOString();
  }

  private migrationId(memoryId: string): string {
    return `decision-memory-${memoryId}`;
  }

  private journalDir(): string {
    return join(this.storage.store.root, "migrations", "decision-memory");
  }

  private journalPath(memoryId: string): string {
    if (!validMigrationMemoryId(memoryId)) {
      throw new Error(`invalid migration memory ID "${memoryId}"`);
    }
    return join(this.journalDir(), `${memoryId}.json`);
  }

  private readJournal(memoryId: string): Journal | undefined {
    const path = this.journalPath(memoryId);
    if (!existsSync(path)) return undefined;
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`read migration journal for memory "${memoryId}": ${errText(e)}`);
    }
    let journal: Journal;
    try {
      journal = JSON.parse(data) as Journal;
    } catch (e) {
      throw new Error(`parse migration journal for memory "${memoryId}": ${errText(e)}`);
    }
    if (
      journal.version !== JOURNAL_VERSION ||
      journal.memoryId !== memoryId ||
      journal.migrationId !== this.migrationId(memoryId)
    ) {
      throw new Error(
        `migration journal for memory "${memoryId}" has an unsupported identity or version`,
      );
    }
    return journal;
  }

  private async writeJournal(journal: Journal): Promise<void> {
    if (this.opts.journalWriter) {
      await this.opts.journalWriter(journal);
      return;
    }
    const path = this.journalPath(journal.memoryId);
    atomicWrite(path, `${goJsonStringify(journalJson(journal), 2)}\n`);
  }

  private async step(memoryId: string, step: string): Promise<void> {
    if (this.opts.beforeStep) await this.opts.beforeStep(memoryId, step);
  }

  // --- preview ------------------------------------------------------------------------------------

  /** Classify every legacy Decision Memory without writing memory, decision, journal or lock files. */
  preview(): PreviewReport {
    const entries = this.storage.memory.list("");
    const legacy = entries.filter((e) => isLegacyDecisionMemoryCategory(e.category ?? ""));
    legacy.sort((a, b) => compareStrings(a.id, b.id));

    const duplicateKeys = new Map<string, string[]>();
    for (const entry of legacy) {
      const key = duplicateKey(entry);
      duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), entry.id]);
    }
    for (const ids of duplicateKeys.values()) sortStrings(ids);
    const duplicateLeaders = new Map<string, string>();
    for (const entry of legacy) {
      const key = duplicateKey(entry);
      if ((duplicateKeys.get(key)?.length ?? 0) < 2 || duplicateLeaders.get(key)) continue;
      const [noise] = classifyNoise(entry);
      if (noise !== NOISE_HIGH) duplicateLeaders.set(key, entry.id);
    }

    const existingIds = new Set<string>();
    for (const decision of this.storage.decisions.list()) existingIds.add(decision.id);
    const reservedIds = new Set(existingIds);

    const report: PreviewReport = {
      candidates: [],
      counts: { total: 0, highNoise: 0, duplicate: 0, withIssue: 0 },
    };
    for (const entry of legacy) {
      const key = duplicateKey(entry);
      const candidate = this.previewCandidate(
        entry,
        duplicateKeys.get(key) ?? [],
        duplicateLeaders.get(key) ?? "",
        existingIds,
        reservedIds,
      );
      report.candidates.push(candidate);
      report.counts.total++;
      if (candidate.noiseLikelihood === NOISE_HIGH) report.counts.highNoise++;
      if (candidate.duplicateGroup) report.counts.duplicate++;
      if ((candidate.sourceIssues?.length ?? 0) > 0) report.counts.withIssue++;
    }
    return report;
  }

  private previewCandidate(
    entry: MemoryEntry,
    duplicateMembers: string[],
    duplicateLeader: string,
    existingIds: Set<string>,
    reservedIds: Set<string>,
  ): Candidate {
    const sources = memorySources(entry);
    const [noise, reasons] = classifyNoise(entry);
    const sourceIssues = classifySourceIssues(entry, sources, existingIds);
    const candidate: Candidate = {
      memoryId: entry.id,
      title: entry.title,
      layer: entry.layer,
      status: entry.status ?? "",
      sources,
      ...(sourceIssues.length > 0 ? { sourceIssues } : {}),
      noiseLikelihood: noise,
      ...(reasons.length > 0 ? { noiseReasons: reasons } : {}),
      proposedResolution: "",
    };
    if (duplicateMembers.length > 1) {
      candidate.duplicateGroup = duplicateGroupId(entry);
      candidate.duplicateMembers = [...duplicateMembers];
    }
    const journal = this.readJournal(entry.id);
    if (journal) {
      candidate.journalState = journal.state;
      if (journal.decisionId) candidate.linkedDecisionId = journal.decisionId;
    }

    if (noise === NOISE_HIGH) {
      candidate.proposedResolution = RESOLUTION_ARCHIVE_NOISE;
      return candidate;
    }
    if (duplicateLeader !== "" && duplicateLeader !== entry.id) {
      candidate.proposedResolution = RESOLUTION_CONSOLIDATE_DUPLICATE;
      candidate.proposedTargetId = duplicateLeader;
      return candidate;
    }
    const decisionId = linkedDecisionSource(sources, existingIds);
    if (decisionId !== "") {
      candidate.proposedResolution = RESOLUTION_LINK_EXISTING;
      candidate.proposedDecisionId = decisionId;
      return candidate;
    }
    if (duplicateLeader === "") {
      const category = proposedMemoryCategory(entry);
      if (category !== "") {
        candidate.proposedResolution = RESOLUTION_RECLASSIFY;
        candidate.proposedCategory = category;
        return candidate;
      }
    }
    candidate.proposedResolution = RESOLUTION_CREATE_DECISION;
    candidate.proposedDecisionId = newDecisionIdAt(entry.title, entry.createdAt, (id) =>
      reservedIds.has(id),
    );
    reservedIds.add(candidate.proposedDecisionId);
    return candidate;
  }

  // --- apply --------------------------------------------------------------------------------------

  /**
   * Execute only explicitly selected candidates. Items are ordered so a duplicate target is
   * established before followers are consolidated into it.
   */
  async apply(selections: Selection[]): Promise<ApplyResult> {
    if (selections.length === 0) {
      throw new Error("at least one explicitly reviewed migration selection is required");
    }
    const normalized: Selection[] = [];
    const seen = new Set<string>();
    for (const raw of selections) {
      const selection = canonicalSelection(raw);
      validateSelection(selection);
      if (seen.has(selection.memoryId)) {
        throw new Error(`memory "${selection.memoryId}" is selected more than once`);
      }
      seen.add(selection.memoryId);
      normalized.push(selection);
    }
    normalized.sort((a, b) => {
      const l = applyRank(a.resolution);
      const r = applyRank(b.resolution);
      if (l !== r) return l - r;
      return compareStrings(a.memoryId, b.memoryId);
    });

    const result: ApplyResult = { results: [] };
    let failures = 0;
    try {
      await this.storage.store.withDecisionMemoryMigrationLock(async () => {
        for (const selection of normalized) {
          let item: ItemResult;
          try {
            item = await this.applyOne(selection);
          } catch (itemErr) {
            failures++;
            item = {
              memoryId: selection.memoryId,
              resolution: selection.resolution,
              state: JOURNAL_FAILED,
              legacyExcluded: false,
              error: errText(itemErr),
            };
          }
          result.results.push(item);
        }
      });
    } catch (err) {
      throw new MigrationApplyError(errText(err), result);
    }
    if (failures > 0) {
      throw new MigrationApplyError(`${failures} Decision Memory migration item(s) failed`, result);
    }
    return result;
  }

  private async applyOne(selection: Selection): Promise<ItemResult> {
    const existingJournal = this.readJournal(selection.memoryId);
    if (existingJournal) {
      if (!sameSelection(existingJournal.selection, selection)) {
        throw new Error(
          `memory "${selection.memoryId}" already has a migration journal for a different reviewed selection`,
        );
      }
      switch (existingJournal.state) {
        case JOURNAL_APPLIED:
          return this.resumeApplied(existingJournal);
        case JOURNAL_ROLLED_BACK:
          throw new Error(
            `migration for memory "${selection.memoryId}" was rolled back; create a new reviewed migration selection`,
          );
        case JOURNAL_PENDING:
        case JOURNAL_FAILED:
          try {
            await this.compensate(existingJournal);
          } catch (err) {
            throw new Error(
              `recover prior ${existingJournal.state} migration for memory "${selection.memoryId}": ${errText(err)}`,
              { cause: err },
            );
          }
          break;
      }
    }

    const memory = this.storage.memory.get(selection.memoryId);
    if (!isLegacyDecisionMemoryCategory(memory.category ?? "")) {
      throw new Error(`memory "${selection.memoryId}" is no longer a legacy Decision Memory`);
    }
    const journal = this.prepareJournal(selection, memory);
    await this.writeJournal(journal);

    try {
      await this.executeJournal(journal, memory);
    } catch (err) {
      throw await this.failAndCompensate(journal, err);
    }
    journal.state = JOURNAL_APPLIED;
    delete journal.error;
    journal.updatedAt = this.now();
    try {
      await this.step(selection.memoryId, "before_commit");
      await this.writeJournal(journal);
    } catch (err) {
      throw await this.failAndCompensate(journal, err);
    }
    return itemFromJournal(journal, false);
  }

  private prepareJournal(selection: Selection, memory: MemoryEntry): Journal {
    const now = this.now();
    const journal: Journal = {
      version: JOURNAL_VERSION,
      migrationId: this.migrationId(memory.id),
      memoryId: memory.id,
      selection,
      originalMemory: cloneMemory(memory),
      state: JOURNAL_PENDING,
      legacyExcluded: false,
      createdAt: now,
      updatedAt: now,
    };
    const memoryRef = memoryReference(memory.id);

    switch (selection.resolution) {
      case RESOLUTION_CREATE_DECISION: {
        let id = selection.decisionId ?? "";
        if (id !== "") {
          if (!validDecisionId(id)) throw new Error(`invalid decision ID "${id}"`);
          if (this.decisionExists(id)) throw new Error(`decision "${id}" already exists`);
        } else {
          id = newDecisionIdAt(memory.title, memory.createdAt, (c) => this.decisionExists(c));
        }
        journal.decisionId = id;
        journal.decisionCreated = true;
        journal.addedSources = sortedUnique([memoryRef, ...migrationDecisionSources(memory, id)]);
        journal.addedDocs = [...(selection.relatedDocs ?? [])];
        journal.addedTasks = [...(selection.relatedTasks ?? [])];
        break;
      }
      case RESOLUTION_LINK_EXISTING: {
        const decision = this.storage.decisions.get(selection.decisionId ?? "");
        const requested = [memoryRef, ...migrationDecisionSources(memory, decision.id)];
        journal.decisionId = decision.id;
        journal.addedSources = addedValues(decision.sources, requested);
        journal.addedDocs = addedValues(decision.relatedDocs, selection.relatedDocs);
        journal.addedTasks = addedValues(decision.relatedTasks, selection.relatedTasks);
        break;
      }
      case RESOLUTION_CONSOLIDATE_DUPLICATE: {
        const decisionId = this.resolveDuplicateDecision(selection.targetMemoryId ?? "");
        const decision = this.storage.decisions.get(decisionId);
        journal.decisionId = decision.id;
        journal.addedSources = addedValues(decision.sources, [memoryRef]);
        break;
      }
      case RESOLUTION_RECLASSIFY:
      case RESOLUTION_ARCHIVE_NOISE:
      case RESOLUTION_REJECT_NOISE:
      case RESOLUTION_LEAVE_UNCHANGED:
        break;
      default:
        throw new Error(`unsupported migration resolution "${selection.resolution}"`);
    }
    return journal;
  }

  private decisionExists(id: string): boolean {
    try {
      this.storage.decisions.get(id);
      return true;
    } catch {
      return false;
    }
  }

  private resolveDuplicateDecision(targetMemoryId: string): string {
    if (!validMigrationMemoryId(targetMemoryId)) {
      throw new Error(`invalid duplicate target memory ID "${targetMemoryId}"`);
    }
    const targetJournal = this.readJournal(targetMemoryId);
    if (targetJournal && targetJournal.state === JOURNAL_APPLIED && targetJournal.decisionId) {
      return targetJournal.decisionId;
    }
    const target = this.storage.memory.get(targetMemoryId);
    const linked = target.metadata?.[LEGACY_DECISION_MIGRATION_DECISION_KEY];
    if (linked) return linked;
    throw new Error(
      `duplicate target memory "${targetMemoryId}" has no applied Decision migration`,
    );
  }

  private async executeJournal(journal: Journal, memory: MemoryEntry): Promise<void> {
    await this.step(memory.id, "before_decision");
    switch (journal.selection.resolution) {
      case RESOLUTION_CREATE_DECISION:
        await this.storage.decisions.create(migrationDecision(memory, journal), {
          now: new Date(journal.createdAt),
        });
        break;
      case RESOLUTION_LINK_EXISTING:
      case RESOLUTION_CONSOLIDATE_DUPLICATE:
        await this.storage.decisions.link(
          journal.decisionId ?? "",
          journal.addedDocs ?? [],
          journal.addedTasks ?? [],
          journal.addedSources ?? [],
        );
        break;
    }

    if (journal.selection.acceptVerified && journal.decisionId) {
      const decision = this.storage.decisions.get(journal.decisionId);
      if (!isCurrent(decision)) {
        try {
          await new DecisionReviewService(this.storage, this.opts.decisionReview).accept(
            journal.decisionId,
            {},
          );
        } catch (err) {
          throw new Error(`verify migrated decision "${journal.decisionId}": ${errText(err)}`, {
            cause: err,
          });
        }
      }
    }

    await this.step(memory.id, "before_memory");
    switch (journal.selection.resolution) {
      case RESOLUTION_RECLASSIFY:
      case RESOLUTION_ARCHIVE_NOISE:
      case RESOLUTION_REJECT_NOISE:
        await this.applyMemoryResolution(journal, memory);
        return;
      case RESOLUTION_CREATE_DECISION:
      case RESOLUTION_LINK_EXISTING:
      case RESOLUTION_CONSOLIDATE_DUPLICATE:
        await this.finalizeLegacyExclusion(journal, memory);
        return;
      case RESOLUTION_LEAVE_UNCHANGED:
        return;
      default:
        throw new Error(`unsupported migration resolution "${journal.selection.resolution}"`);
    }
  }

  private async applyMemoryResolution(journal: Journal, memory: MemoryEntry): Promise<void> {
    const updated = cloneMemory(memory);
    switch (journal.selection.resolution) {
      case RESOLUTION_RECLASSIFY:
        updated.category = journal.selection.category ?? "";
        break;
      case RESOLUTION_ARCHIVE_NOISE:
        updated.status = "archived";
        break;
      case RESOLUTION_REJECT_NOISE:
        updated.status = "rejected";
        updated.rejectedReason = firstNonEmpty(
          journal.selection.reason ?? "",
          "Reviewed as legacy Decision Memory noise",
        );
        break;
    }
    markMigratedMemory(updated, journal);
    await this.storage.memory.update(updated);
    journal.legacyExcluded = true;
  }

  private async finalizeLegacyExclusion(journal: Journal, memory: MemoryEntry): Promise<void> {
    if (!this.consumptionActive || !journal.decisionId) return;
    const decision = this.storage.decisions.get(journal.decisionId);
    if (!isCurrent(decision)) return;
    const current = this.storage.memory.get(memory.id);
    if (
      current.metadata?.[LEGACY_DECISION_MIGRATION_ID_KEY] === journal.migrationId &&
      !memoryCurrentForDefaultRetrieval(current)
    ) {
      journal.legacyExcluded = true;
      return;
    }
    if (!isLegacyDecisionMemoryCategory(current.category ?? "")) {
      throw new Error(`memory "${memory.id}" changed category outside migration`);
    }
    const updated = cloneMemory(current);
    if (updated.status !== "rejected") updated.status = "archived";
    updated.mergedInto = decisionRef(journal.decisionId);
    markMigratedMemory(updated, journal);
    await this.storage.memory.update(updated);
    journal.legacyExcluded = true;
  }

  private async resumeApplied(journal: Journal): Promise<ItemResult> {
    if (!journal.decisionId || journal.legacyExcluded) return itemFromJournal(journal, true);
    const memory = this.storage.memory.get(journal.memoryId);
    const wasExcluded = journal.legacyExcluded;
    await this.finalizeLegacyExclusion(journal, memory);
    if (journal.legacyExcluded !== wasExcluded) {
      journal.updatedAt = this.now();
      try {
        await this.writeJournal(journal);
      } catch (err) {
        try {
          await this.storage.memory.restoreLegacyDecisionMigration(
            journal.originalMemory as MemoryEntry,
            expectedMigratedMemory(journal),
            journal.migrationId,
          );
        } catch (restoreErr) {
          throw new Error(
            `update finalized migration journal: ${errText(err)} (memory rollback failed: ${errText(restoreErr)})`,
          );
        }
        journal.legacyExcluded = false;
        throw err;
      }
    }
    return itemFromJournal(journal, true);
  }

  private async failAndCompensate(journal: Journal, cause: unknown): Promise<Error> {
    let compensationErr: unknown;
    try {
      await this.compensate(journal);
    } catch (e) {
      compensationErr = e;
    }
    journal.state = JOURNAL_FAILED;
    journal.error = errText(cause);
    journal.legacyExcluded = false;
    journal.updatedAt = this.now();
    let journalErr: unknown;
    try {
      await this.writeJournal(journal);
    } catch (e) {
      journalErr = e;
    }
    if (compensationErr !== undefined || journalErr !== undefined) {
      const show = (e: unknown) => (e === undefined ? "<nil>" : errText(e));
      return new Error(
        `migration failed: ${errText(cause)} (compensation: ${show(compensationErr)}; journal: ${show(journalErr)})`,
      );
    }
    return cause instanceof Error ? cause : new Error(String(cause));
  }

  private async compensate(journal: Journal): Promise<void> {
    let firstErr: unknown;
    if (journal.originalMemory) {
      let current: MemoryEntry | undefined;
      try {
        current = this.storage.memory.get(journal.memoryId);
      } catch {
        current = undefined;
      }
      if (current?.metadata?.[LEGACY_DECISION_MIGRATION_ID_KEY] === journal.migrationId) {
        try {
          await this.storage.memory.restoreLegacyDecisionMigration(
            cloneMemory(journal.originalMemory),
            expectedMigratedMemory(journal),
            journal.migrationId,
          );
        } catch (err) {
          firstErr = err;
        }
      }
    }
    if (journal.decisionId) {
      if (!this.decisionExists(journal.decisionId) && journal.decisionCreated) {
        if (firstErr !== undefined) throw firstErr;
        return;
      }
      try {
        await this.storage.decisions.rollbackLegacyMemoryMigration(
          journal.decisionId,
          memoryReference(journal.memoryId),
          journal.decisionCreated === true,
          journal.addedSources ?? [],
          journal.addedDocs ?? [],
          journal.addedTasks ?? [],
        );
      } catch (err) {
        if (firstErr === undefined) firstErr = err;
      }
    }
    if (firstErr !== undefined) throw firstErr;
  }

  // --- rollback -----------------------------------------------------------------------------------

  /** Reverse one reviewed migration from its durable journal. Idempotent. */
  async rollback(memoryId: string): Promise<RollbackResult> {
    if (!validMigrationMemoryId(memoryId)) {
      throw new Error(`invalid migration memory ID "${memoryId}"`);
    }
    let result: RollbackResult | undefined;
    await this.storage.store.withDecisionMemoryMigrationLock(async () => {
      const journal = this.readJournal(memoryId);
      if (!journal) throw new Error(`migration journal for memory "${memoryId}" not found`);
      if (journal.state === JOURNAL_ROLLED_BACK) {
        result = rollbackOf(memoryId, journal);
        return;
      }
      await this.compensate(journal);
      journal.state = JOURNAL_ROLLED_BACK;
      journal.legacyExcluded = false;
      delete journal.error;
      journal.updatedAt = this.now();
      await this.writeJournal(journal);
      result = rollbackOf(memoryId, journal);
    });
    return result as RollbackResult;
  }
}

function rollbackOf(memoryId: string, journal: Journal): RollbackResult {
  return {
    memoryId,
    state: JOURNAL_ROLLED_BACK,
    ...(journal.decisionId ? { decisionId: journal.decisionId } : {}),
  };
}

function isCurrent(d: DecisionEntry): boolean {
  return (
    d.status === "accepted" && d.verifiedAt !== undefined && (d.supersededBy?.length ?? 0) === 0
  );
}

function applyRank(resolution: string): number {
  return resolution === RESOLUTION_CONSOLIDATE_DUPLICATE ? 2 : 1;
}

export function canonicalSelection(selection: Selection): Selection {
  const out: Selection = {
    memoryId: goTrimSpace(selection.memoryId),
    resolution: goTrimSpace(selection.resolution),
  };
  const decisionId = goTrimSpace(selection.decisionId ?? "");
  if (decisionId) out.decisionId = decisionId;
  const target = goTrimSpace(selection.targetMemoryId ?? "");
  if (target) out.targetMemoryId = target;
  const category = goTrimSpace(selection.category ?? "").toLowerCase();
  if (category) out.category = category;
  const reason = goTrimSpace(selection.reason ?? "");
  if (reason) out.reason = reason;
  const docs = sortedUnique(selection.relatedDocs);
  if (docs.length > 0) out.relatedDocs = docs;
  const tasks = sortedUnique(selection.relatedTasks);
  if (tasks.length > 0) out.relatedTasks = tasks;
  if (selection.acceptVerified) out.acceptVerified = true;
  return out;
}

function sameSelection(left: Selection, right: Selection): boolean {
  const l = canonicalSelection(left);
  const r = canonicalSelection(right);
  return (
    l.memoryId === r.memoryId &&
    l.resolution === r.resolution &&
    (l.decisionId ?? "") === (r.decisionId ?? "") &&
    (l.targetMemoryId ?? "") === (r.targetMemoryId ?? "") &&
    (l.category ?? "") === (r.category ?? "") &&
    (l.reason ?? "") === (r.reason ?? "") &&
    (l.acceptVerified ?? false) === (r.acceptVerified ?? false) &&
    (l.relatedDocs ?? []).join("\0") === (r.relatedDocs ?? []).join("\0") &&
    (l.relatedTasks ?? []).join("\0") === (r.relatedTasks ?? []).join("\0")
  );
}

function itemFromJournal(journal: Journal, idempotent: boolean): ItemResult {
  return {
    memoryId: journal.memoryId,
    resolution: journal.selection.resolution,
    state: journal.state,
    ...(journal.decisionId ? { decisionId: journal.decisionId } : {}),
    legacyExcluded: journal.legacyExcluded,
    ...(idempotent ? { idempotent: true } : {}),
    ...(journal.error ? { error: journal.error } : {}),
  };
}

function migrationDecision(memory: MemoryEntry, journal: Journal): DecisionEntry {
  return {
    id: journal.decisionId ?? "",
    title: memory.title,
    status: "draft",
    tags: ["legacy-memory-migration"],
    sources: [...(journal.addedSources ?? [])],
    relatedDocs: [...(journal.addedDocs ?? [])],
    relatedTasks: [...(journal.addedTasks ?? [])],
    createdAt: memory.createdAt,
    updatedAt: "",
    context: `Migrated through reviewed provenance from legacy Decision Memory ${memoryReference(memory.id)} (layer ${memory.layer}, prior status ${memory.status ?? ""}).`,
    decision: goTrimSpace(memory.content ?? ""),
    alternativesConsidered:
      "The legacy Memory record did not encode alternatives in the System Decision lifecycle.",
    consequences:
      "This Decision remains draft until linked evidence is verified. The legacy record stays in default retrieval until this Decision becomes current accepted guidance.",
  };
}

function migrationDecisionSources(memory: MemoryEntry, decisionId: string): string[] {
  const selfRef = decisionRef(decisionId);
  return sortedUnique(memorySources(memory).filter((s) => s !== selfRef));
}

function markMigratedMemory(memory: MemoryEntry, journal: Journal): void {
  const metadata = memory.metadata ?? {};
  metadata[LEGACY_DECISION_MIGRATION_ID_KEY] = journal.migrationId;
  metadata[LEGACY_DECISION_MIGRATION_RESOLUTION_KEY] = journal.selection.resolution;
  if (journal.decisionId) metadata[LEGACY_DECISION_MIGRATION_DECISION_KEY] = journal.decisionId;
  memory.metadata = metadata;
}

function expectedMigratedMemory(journal: Journal): MemoryEntry | undefined {
  if (!journal.originalMemory) return undefined;
  const expected = cloneMemory(journal.originalMemory);
  switch (journal.selection.resolution) {
    case RESOLUTION_RECLASSIFY:
      expected.category = journal.selection.category ?? "";
      break;
    case RESOLUTION_ARCHIVE_NOISE:
      expected.status = "archived";
      break;
    case RESOLUTION_REJECT_NOISE:
      expected.status = "rejected";
      expected.rejectedReason = firstNonEmpty(
        journal.selection.reason ?? "",
        "Reviewed as legacy Decision Memory noise",
      );
      break;
    case RESOLUTION_CREATE_DECISION:
    case RESOLUTION_LINK_EXISTING:
    case RESOLUTION_CONSOLIDATE_DUPLICATE:
      if (expected.status !== "rejected") expected.status = "archived";
      expected.mergedInto = decisionRef(journal.decisionId ?? "");
      break;
    default:
      return undefined;
  }
  markMigratedMemory(expected, journal);
  return expected;
}

// --- classification -------------------------------------------------------------------------------

function duplicateKey(entry: MemoryEntry): string {
  const value = normalizeMigrationText(entry.content ?? "");
  return value !== "" ? value : normalizeMigrationText(entry.title);
}

function duplicateGroupId(entry: MemoryEntry): string {
  return `dup-${createHash("sha256").update(duplicateKey(entry)).digest("hex").slice(0, 12)}`;
}

/** memorySources: declared sources plus inline @doc/@task/@decision/@memory references, sorted. */
export function memorySources(entry: MemoryEntry): string[] {
  const seen = new Set<string>();
  for (const source of entry.sources ?? []) {
    const s = goTrimSpace(source);
    if (s !== "") seen.add(s);
  }
  for (const match of (entry.content ?? "").matchAll(INLINE_SOURCE)) {
    seen.add(match[0].replace(/[.,;:!?)\]}]+$/, ""));
  }
  return sortStrings([...seen]);
}

function classifySourceIssues(
  entry: MemoryEntry,
  sources: string[],
  existingIds: Set<string>,
): string[] {
  const issues: string[] = [];
  if (sources.length === 0) issues.push("missing_source");
  if (!validMigrationMemoryId(entry.id)) issues.push("invalid_memory_id");
  for (const source of sources) {
    if (!source.startsWith("@decision/")) continue;
    const id = source.slice("@decision/".length);
    if (!validDecisionId(id) || !existingIds.has(id)) {
      issues.push(`decision_source_not_found:${id}`);
    }
  }
  return sortStrings(issues);
}

function linkedDecisionSource(sources: string[], existingIds: Set<string>): string {
  for (const source of sources) {
    if (!source.startsWith("@decision/")) continue;
    const id = source.slice("@decision/".length);
    if (validDecisionId(id) && existingIds.has(id)) return id;
  }
  return "";
}

export function classifyNoise(entry: MemoryEntry): [string, string[]] {
  const title = normalizeMigrationText(entry.title);
  if (title === "project workflow decision" || title === "instruction source of truth") {
    return [NOISE_HIGH, ["generic_runtime_capture_title"]];
  }
  for (const [rawKey, rawValue] of Object.entries(entry.metadata ?? {})) {
    const key = goTrimSpace(rawKey).toLowerCase();
    const value = goTrimSpace(rawValue).toLowerCase();
    if (
      (key.includes("runtime") || key.includes("prompt") || key.includes("instruction")) &&
      value !== "" &&
      value !== "false" &&
      value !== "0"
    ) {
      return [NOISE_HIGH, ["runtime_capture_metadata"]];
    }
  }
  if (goFields(entry.content ?? "").length < 8 || title.includes("instruction")) {
    return [NOISE_MEDIUM, ["low_context_candidate"]];
  }
  return [NOISE_LOW, []];
}

function proposedMemoryCategory(entry: MemoryEntry): string {
  const text = normalizeMigrationText(`${entry.title} ${entry.content ?? ""}`);
  if (text.includes(" convention ") || text.startsWith("convention ")) return "convention";
  if (text.includes(" pattern ") || text.startsWith("pattern ")) return "pattern";
  if (text.includes(" prefer ") || text.includes(" preference ") || text.startsWith("prefer ")) {
    return "preference";
  }
  return "";
}

export { applyResultJson, previewReportJson, rollbackResultJson };
