// Port of internal/storage/decision_store.go: System Decisions in .knowns/decisions/.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type DecisionEntry,
  type DecisionReviewMatch,
  decisionCurrentForDefaultRetrieval,
  decisionFileName,
  decisionRef,
  newDecisionId,
  validDecisionId,
  validDecisionReviewState,
  validDecisionStatus,
} from "../../models/decision.ts";
import type { Store } from "../core/store.ts";
import { atomicWrite, goTrimSpace, splitFrontmatter } from "../core/util.ts";
import {
  asStr,
  asStrList,
  formatIso,
  goTimeJson,
  isZeroTime,
  parseIso,
  parseYamlMap,
  readDirSorted,
  readTime,
  yamlScalar,
  yamlStringList,
} from "./internal.ts";

export interface DecisionCreateOptions {
  /** Defaults to now. */
  now?: Date;
}

interface MdSection {
  title: string;
  content: string;
}

function markdownSections(body: string): MdSection[] {
  const sections: MdSection[] = [];
  let current: { title: string } | undefined;
  let content: string[] = [];
  const flush = () => {
    if (!current) return;
    sections.push({ title: current.title, content: goTrimSpace(content.join("\n")) });
    content = [];
  };
  for (const line of body.split("\n")) {
    const trimmed = goTrimSpace(line);
    if (trimmed.startsWith("## ")) {
      flush();
      current = { title: goTrimSpace(trimmed.slice(3)) };
      continue;
    }
    if (current) content.push(line);
  }
  flush();
  return sections;
}

function parseReviewMatches(v: unknown): DecisionReviewMatch[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("reviewMatches must be a list");
  const out = v.map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const match: DecisionReviewMatch = {
      id: asStr(m.id),
      title: asStr(m.title),
      score: typeof m.score === "number" ? m.score : Number(asStr(m.score) || 0),
    };
    for (const k of ["status", "kind", "snippet", "hash"] as const) {
      const s = asStr(m[k]);
      if (s !== "") match[k] = s;
    }
    const matchedBy = asStrList(m.matchedBy);
    if (matchedBy.length > 0) match.matchedBy = matchedBy;
    const tags = asStrList(m.tags);
    if (tags.length > 0) match.tags = tags;
    return match;
  });
  return out.length === 0 ? undefined : out;
}

/** parseDecisionContent: a decision file's markdown into a DecisionEntry. */
export function parseDecisionContent(content: string): DecisionEntry {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === "") throw new Error("missing decision frontmatter");
  let fm: Record<string, unknown>;
  try {
    fm = parseYamlMap(yaml);
  } catch (e) {
    throw new Error(`parse decision frontmatter: ${(e as Error).message}`);
  }
  const d: DecisionEntry = {
    id: asStr(fm.id),
    title: asStr(fm.title),
    status: asStr(fm.status),
    createdAt: readTime(asStr(fm.createdAt)),
    updatedAt: readTime(asStr(fm.updatedAt)),
  };
  const lists = [
    "supersedes",
    "supersededBy",
    "tags",
    "sources",
    "relatedDocs",
    "relatedTasks",
    "verification",
    "reviewBlockers",
    "reviewAllowedResolutions",
  ] as const;
  for (const k of lists) {
    const list = asStrList(fm[k]);
    if (list.length > 0) d[k] = list;
  }
  const reviewState = asStr(fm.reviewState);
  if (reviewState !== "") d.reviewState = reviewState;
  const matches = parseReviewMatches(fm.reviewMatches);
  if (matches) d.reviewMatches = matches;
  d.content = goTrimSpace(body);
  const verifiedAt = asStr(fm.verifiedAt);
  if (verifiedAt !== "" && parseIso(verifiedAt)) d.verifiedAt = goTimeJson(verifiedAt);
  const hash = asStr(fm.reviewEvaluatedHash);
  if (hash !== "") d.reviewEvaluatedHash = hash;
  const evaluatedAt = asStr(fm.reviewEvaluatedAt);
  if (evaluatedAt !== "" && parseIso(evaluatedAt)) d.reviewEvaluatedAt = goTimeJson(evaluatedAt);
  for (const section of markdownSections(d.content)) {
    if (section.content === "") continue;
    switch (section.title.toLowerCase()) {
      case "context":
        d.context = section.content;
        break;
      case "decision":
        d.decision = section.content;
        break;
      case "alternatives considered":
        d.alternativesConsidered = section.content;
        break;
      case "consequences":
        d.consequences = section.content;
        break;
    }
  }
  return d;
}

function writeSection(title: string, content: string, first: boolean): string {
  let out = first ? "" : "\n";
  out += `## ${title}\n\n`;
  if (goTrimSpace(content) !== "") out += `${goTrimSpace(content)}\n`;
  return out;
}

/** renderDecisionBody: the stored Content when set, else the four sections. */
export function renderDecisionBody(d: DecisionEntry): string {
  const content = goTrimSpace(d.content ?? "");
  if (content !== "") return `${content}\n`;
  let out = "";
  out += writeSection("Context", d.context ?? "", out === "");
  out += writeSection("Decision", d.decision ?? "", out === "");
  out += writeSection("Alternatives Considered", d.alternativesConsidered ?? "", out === "");
  out += writeSection("Consequences", d.consequences ?? "", out === "");
  return `${out.replace(/\n+$/, "")}\n`;
}

function indentedList(key: string, values: readonly string[] | undefined, spaces: number): string {
  if (!values || values.length === 0) return "";
  const indent = " ".repeat(spaces);
  return `${indent}${key}:\n${values.map((v) => `${indent}  - ${yamlScalar(v)}\n`).join("")}`;
}

function renderReviewMatches(matches: readonly DecisionReviewMatch[] | undefined): string {
  if (!matches || matches.length === 0) return "reviewMatches: []\n";
  let b = "reviewMatches:\n";
  for (const m of matches) {
    b += `  - id: ${yamlScalar(m.id)}\n`;
    b += `    title: ${yamlScalar(m.title)}\n`;
    if (m.status) b += `    status: ${yamlScalar(m.status)}\n`;
    b += `    score: ${m.score.toFixed(6)}\n`;
    if (m.kind) b += `    kind: ${yamlScalar(m.kind)}\n`;
    if (m.hash) b += `    hash: ${yamlScalar(m.hash)}\n`;
    b += indentedList("matchedBy", m.matchedBy, 4);
    if (m.snippet) b += `    snippet: ${yamlScalar(m.snippet)}\n`;
    b += indentedList("tags", m.tags, 4);
  }
  return b;
}

/** renderDecision: the canonical markdown for a decision file. */
export function renderDecision(d: DecisionEntry): string {
  let b = "---\n";
  b += `id: ${yamlScalar(d.id)}\n`;
  b += `title: ${yamlScalar(d.title)}\n`;
  b += `status: ${yamlScalar(d.status)}\n`;
  b += yamlStringList("supersedes", d.supersedes);
  b += yamlStringList("supersededBy", d.supersededBy);
  b += yamlStringList("tags", d.tags);
  b += yamlStringList("sources", d.sources);
  b += yamlStringList("relatedDocs", d.relatedDocs);
  b += yamlStringList("relatedTasks", d.relatedTasks);
  b += yamlStringList("verification", d.verification);
  if (d.verifiedAt !== undefined) b += `verifiedAt: '${formatIso(d.verifiedAt)}'\n`;
  if (
    (d.reviewState ?? "") !== "" ||
    (d.reviewBlockers?.length ?? 0) > 0 ||
    (d.reviewMatches?.length ?? 0) > 0 ||
    (d.reviewAllowedResolutions?.length ?? 0) > 0 ||
    (d.reviewEvaluatedHash ?? "") !== "" ||
    d.reviewEvaluatedAt !== undefined
  ) {
    b += `reviewState: ${yamlScalar(d.reviewState ?? "")}\n`;
    b += yamlStringList("reviewBlockers", d.reviewBlockers);
    b += renderReviewMatches(d.reviewMatches);
    b += yamlStringList("reviewAllowedResolutions", d.reviewAllowedResolutions);
    if (d.reviewEvaluatedHash) b += `reviewEvaluatedHash: '${d.reviewEvaluatedHash}'\n`;
    if (d.reviewEvaluatedAt !== undefined) {
      b += `reviewEvaluatedAt: '${formatIso(d.reviewEvaluatedAt)}'\n`;
    }
  }
  b += `createdAt: '${formatIso(d.createdAt)}'\n`;
  b += `updatedAt: '${formatIso(d.updatedAt)}'\n`;
  b += "---\n\n";
  b += renderDecisionBody(d);
  if (!b.endsWith("\n")) b += "\n";
  return b;
}

/**
 * The map CanonicalDecisionHash feeds to hashSnapshot (the history port owns the hash itself).
 * Review fields, timestamps and the ID are deliberately absent.
 */
export function canonicalDecisionSnapshot(entry: DecisionEntry): Record<string, unknown> {
  const list = (v: string[] | undefined) => (v && v.length > 0 ? v : null);
  return {
    title: entry.title,
    status: entry.status,
    supersedes: list(entry.supersedes),
    supersededBy: list(entry.supersededBy),
    tags: list(entry.tags),
    sources: list(entry.sources),
    relatedDocs: list(entry.relatedDocs),
    relatedTasks: list(entry.relatedTasks),
    verification: list(entry.verification),
    verifiedAt: entry.verifiedAt ?? null,
    body: renderDecisionBody(entry),
  };
}

/** appendUniqueStrings: trimmed, de-duplicated, order preserved. */
export function appendUniqueStrings(
  existing: readonly string[] | undefined,
  ...values: string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...(existing ?? []), ...values]) {
    const t = goTrimSpace(v);
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

const contains = (values: readonly string[] | undefined, target: string) =>
  (values ?? []).includes(target);

export class DecisionStore {
  readonly root: string;
  /** Test seam mirroring DecisionStore.writeFile in Go. */
  writeFile: ((path: string, data: string) => void) | undefined;

  constructor(private readonly store: Pick<Store, "root" | "withDecisionLifecycleLock">) {
    this.root = store.root;
  }

  decisionsDir(): string {
    return join(this.root, "decisions");
  }

  private write(path: string, data: string): void {
    if (this.writeFile) this.writeFile(path, data);
    else atomicWrite(path, data);
  }

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.store.withDecisionLifecycleLock(fn);
  }

  /** List: newest first, ID ascending on ties. */
  list(): DecisionEntry[] {
    const decisions: DecisionEntry[] = [];
    for (const e of readDirSorted(this.decisionsDir())) {
      if (e.isDirectory() || !e.name.endsWith(".md")) continue;
      try {
        decisions.push(this.parseFile(join(this.decisionsDir(), e.name)));
      } catch {
        // skip
      }
    }
    return decisions.sort((a, b) => {
      const x = parseIso(a.createdAt)?.ms ?? 0;
      const y = parseIso(b.createdAt)?.ms ?? 0;
      if (x === y) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return y - x;
    });
  }

  get(id: string): DecisionEntry {
    if (goTrimSpace(id) === "") throw new Error("decision ID is required");
    if (!validDecisionId(id)) throw new Error(`invalid decision ID: "${id}"`);
    const abs = join(this.decisionsDir(), decisionFileName(id));
    if (!existsSync(abs)) throw new Error(`decision "${id}" not found`);
    return this.parseFile(abs);
  }

  create(decision: DecisionEntry, opts: DecisionCreateOptions = {}): Promise<void> {
    return this.withLock(() => this.createUnlocked(decision, opts));
  }

  createUnlocked(d: DecisionEntry, opts: DecisionCreateOptions = {}): void {
    if (!d) throw new Error("decision is required");
    if (goTrimSpace(d.title) === "") throw new Error("decision title is required");
    const now = opts.now ?? new Date();
    const idTime = isZeroTime(d.createdAt)
      ? now
      : new Date(parseIso(d.createdAt)?.ms ?? now.getTime());
    const persistedNow = now.toISOString();
    if (isZeroTime(d.createdAt)) d.createdAt = persistedNow;
    if (isZeroTime(d.updatedAt)) d.updatedAt = persistedNow;
    if (!d.status) d.status = "draft";
    if (!validDecisionStatus(d.status)) throw new Error(`invalid decision status: "${d.status}"`);
    if (!validDecisionReviewState(d.reviewState ?? "")) {
      throw new Error(`invalid decision review state: "${d.reviewState}"`);
    }
    if (d.id === "") {
      d.id = newDecisionId(d.title, idTime, (id) =>
        existsSync(join(this.decisionsDir(), decisionFileName(id))),
      );
    }
    if (!validDecisionId(d.id)) throw new Error(`invalid decision ID: "${d.id}"`);
    const abs = join(this.decisionsDir(), decisionFileName(d.id));
    if (existsSync(abs)) throw new Error(`decision "${d.id}" already exists`);
    mkdirSync(this.decisionsDir(), { recursive: true, mode: 0o755 });
    this.write(abs, renderDecision(d));
  }

  update(decision: DecisionEntry): Promise<void> {
    return this.withLock(() => this.updateUnlocked(decision));
  }

  updateUnlocked(d: DecisionEntry): void {
    if (!d || goTrimSpace(d.id) === "") throw new Error("decision ID is required");
    if (!validDecisionId(d.id)) throw new Error(`invalid decision ID: "${d.id}"`);
    const existing = this.get(d.id);
    if (goTrimSpace(d.title) === "") throw new Error("decision title is required");
    if (isZeroTime(d.createdAt)) d.createdAt = existing.createdAt;
    d.updatedAt = new Date().toISOString();
    if (!d.status) d.status = existing.status;
    if (!validDecisionStatus(d.status)) throw new Error(`invalid decision status: "${d.status}"`);
    if (!validDecisionReviewState(d.reviewState ?? "")) {
      throw new Error(`invalid decision review state: "${d.reviewState}"`);
    }
    this.write(join(this.decisionsDir(), decisionFileName(d.id)), renderDecision(d));
  }

  /** Link: append related references to a decision. */
  link(id: string, docs: string[], tasks: string[], sources: string[]): Promise<DecisionEntry> {
    return this.withLock(() => {
      const d = this.get(id);
      d.relatedDocs = appendUniqueStrings(d.relatedDocs, ...docs);
      d.relatedTasks = appendUniqueStrings(d.relatedTasks, ...tasks);
      d.sources = appendUniqueStrings(d.sources, ...sources);
      this.updateUnlocked(d);
      return this.get(id);
    });
  }

  /** LinkCandidateToCurrent: transfer a draft's provenance to a current decision and reject it. */
  linkCandidateToCurrent(
    candidateId: string,
    targetId: string,
    resolvedAt?: Date,
  ): Promise<{ candidate: DecisionEntry; target: DecisionEntry }> {
    return this.withLock(() => {
      let candidate = this.get(candidateId);
      let target = this.get(targetId);
      if (candidate.id === target.id) {
        throw new Error("candidate and target decision must be different");
      }
      const candidateRef = decisionRef(candidate.id);
      const targetRef = decisionRef(target.id);
      if (
        candidate.status === "rejected" &&
        contains(candidate.sources, targetRef) &&
        contains(target.sources, candidateRef)
      ) {
        return { candidate, target };
      }
      if (candidate.status !== "draft") {
        throw new Error(`decision "${candidate.id}" is not an unresolved draft candidate`);
      }
      if (!decisionCurrentForDefaultRetrieval(target)) {
        throw new Error(`decision "${target.id}" is not current accepted guidance`);
      }
      const at = (resolvedAt ?? new Date()).toISOString();
      target.sources = appendUniqueStrings(target.sources, ...(candidate.sources ?? []));
      target.sources = appendUniqueStrings(target.sources, candidateRef);
      target.relatedDocs = appendUniqueStrings(
        target.relatedDocs,
        ...(candidate.relatedDocs ?? []),
      );
      target.relatedTasks = appendUniqueStrings(
        target.relatedTasks,
        ...(candidate.relatedTasks ?? []),
      );
      target.updatedAt = at;
      candidate.status = "rejected";
      candidate.sources = appendUniqueStrings(candidate.sources, targetRef);
      candidate.reviewState = "";
      delete candidate.reviewBlockers;
      delete candidate.reviewAllowedResolutions;
      candidate.updatedAt = at;
      this.writeDecisionSet(candidate, target);
      candidate = this.get(candidateId);
      target = this.get(targetId);
      return { candidate, target };
    });
  }

  /** RejectCandidate: an explicit terminal rejection; repeating it is idempotent. */
  rejectCandidate(id: string, resolvedAt?: Date): Promise<DecisionEntry> {
    return this.withLock(() => {
      const c = this.get(id);
      if (c.status === "rejected") return c;
      if (c.status !== "draft") {
        throw new Error(`decision "${id}" cannot be rejected from status "${c.status}"`);
      }
      c.status = "rejected";
      c.reviewState = "";
      delete c.reviewBlockers;
      delete c.reviewAllowedResolutions;
      c.updatedAt = (resolvedAt ?? new Date()).toISOString();
      this.updateUnlocked(c);
      return this.get(id);
    });
  }

  supersede(oldId: string, newId: string): Promise<{ old: DecisionEntry; next: DecisionEntry }> {
    return this.withLock(() => {
      if (oldId === "" || newId === "") throw new Error("old and new decision IDs are required");
      if (oldId === newId) throw new Error("a decision cannot supersede itself");
      const oldD = this.get(oldId);
      const newD = this.get(newId);
      if (
        oldD.status === "superseded" &&
        contains(oldD.supersededBy, newId) &&
        contains(newD.supersedes, oldId)
      ) {
        return { old: oldD, next: newD };
      }
      if (!decisionCurrentForDefaultRetrieval(oldD)) {
        throw new Error(`decision "${oldId}" is not current accepted guidance`);
      }
      if (!decisionCurrentForDefaultRetrieval(newD)) {
        throw new Error(
          `replacement decision "${newId}" must be accepted with verified evidence before supersession`,
        );
      }
      if (contains(oldD.supersedes, newId)) {
        throw new Error(`supersession would create a cycle between "${oldId}" and "${newId}"`);
      }
      oldD.status = "superseded";
      oldD.supersededBy = appendUniqueStrings(oldD.supersededBy, newId);
      newD.supersedes = appendUniqueStrings(newD.supersedes, oldId);
      const now = new Date().toISOString();
      oldD.updatedAt = now;
      newD.updatedAt = now;
      this.writeDecisionSet(oldD, newD);
      return { old: this.get(oldId), next: this.get(newId) };
    });
  }

  /** Accept: draft -> accepted with verification evidence, optionally superseding others. */
  accept(
    id: string,
    verificationIn: string[],
    supersedes: string[] = [],
    verifiedAtIn?: Date,
  ): Promise<{ accepted: DecisionEntry; replaced: DecisionEntry[] }> {
    return this.withLock(() => {
      const decision = this.get(id);
      if (decision.status !== "draft" && decision.status !== "accepted") {
        throw new Error(`decision "${id}" cannot be accepted from status "${decision.status}"`);
      }
      const verification = appendUniqueStrings(undefined, ...verificationIn);
      if (verification.length === 0) {
        throw new Error(`verification evidence is required to accept decision "${id}"`);
      }
      const verifiedAt = (verifiedAtIn ?? new Date()).toISOString();
      decision.status = "accepted";
      decision.verification = verification;
      decision.verifiedAt = verifiedAt;
      decision.reviewState = "";
      delete decision.reviewBlockers;
      delete decision.reviewMatches;
      delete decision.reviewAllowedResolutions;
      delete decision.reviewEvaluatedAt;
      decision.reviewEvaluatedHash = "";
      decision.updatedAt = verifiedAt;

      const seen = new Set<string>();
      const changed: DecisionEntry[] = [decision];
      const replaced: DecisionEntry[] = [];
      for (const raw of supersedes) {
        const oldId = goTrimSpace(raw);
        if (oldId === "" || seen.has(oldId)) continue;
        seen.add(oldId);
        if (oldId === id) throw new Error("a decision cannot supersede itself");
        const oldD = this.get(oldId);
        if (oldD.status === "superseded" && contains(oldD.supersededBy, id)) {
          decision.supersedes = appendUniqueStrings(decision.supersedes, oldId);
          replaced.push(oldD);
          continue;
        }
        if (!decisionCurrentForDefaultRetrieval(oldD)) {
          throw new Error(`decision "${oldId}" is not current accepted guidance`);
        }
        if (contains(oldD.supersedes, id)) {
          throw new Error(`supersession would create a cycle between "${oldId}" and "${id}"`);
        }
        oldD.status = "superseded";
        oldD.supersededBy = appendUniqueStrings(oldD.supersededBy, id);
        oldD.updatedAt = verifiedAt;
        decision.supersedes = appendUniqueStrings(decision.supersedes, oldId);
        replaced.push(oldD);
        changed.push(oldD);
      }
      this.writeDecisionSet(...changed);
      return {
        accepted: this.get(id),
        replaced: replaced.map((r) => this.get(r.id)),
      };
    });
  }

  /** RollbackLegacyMemoryMigration: remove only the links owned by a reviewed migration. */
  rollbackLegacyMemoryMigration(
    id: string,
    memoryRefIn: string,
    created: boolean,
    addedSources: string[],
    addedDocs: string[],
    addedTasks: string[],
  ): Promise<void> {
    return this.withLock(() => {
      const decision = this.get(id);
      const memoryRef = goTrimSpace(memoryRefIn);
      if (memoryRef === "") throw new Error("legacy memory reference is required");
      if (created) {
        if (
          !contains(decision.tags, "legacy-memory-migration") ||
          !contains(decision.sources, memoryRef)
        ) {
          throw new Error(`decision "${id}" is not owned by migration source "${memoryRef}"`);
        }
        if (
          (decision.supersedes?.length ?? 0) > 0 ||
          (decision.supersededBy?.length ?? 0) > 0 ||
          decision.status === "superseded"
        ) {
          throw new Error(
            `decision "${id}" has supersession relationships; automatic migration rollback is unsafe`,
          );
        }
        switch (decision.status) {
          case "draft":
            rmSync(join(this.decisionsDir(), decisionFileName(id)), { force: true });
            return;
          case "accepted":
            decision.status = "rejected";
            delete decision.verification;
            delete decision.verifiedAt;
            this.updateUnlocked(decision);
            return;
          case "rejected":
          case "archived":
            return;
          default:
            throw new Error(
              `decision "${id}" has status "${decision.status}"; automatic migration rollback is unsafe`,
            );
        }
      }
      let updated = false;
      const strip = (existing: string[] | undefined, owned: string[]) => {
        if (!existing || existing.length === 0 || owned.length === 0) return existing;
        const remove = new Set(owned.map(goTrimSpace).filter((v) => v !== ""));
        const kept = existing.filter((v) => {
          if (remove.has(goTrimSpace(v))) {
            updated = true;
            return false;
          }
          return true;
        });
        return kept;
      };
      decision.sources = strip(decision.sources, addedSources);
      decision.relatedDocs = strip(decision.relatedDocs, addedDocs);
      decision.relatedTasks = strip(decision.relatedTasks, addedTasks);
      if (!updated) return;
      this.updateUnlocked(decision);
    });
  }

  /** writeDecisionSet: write several decisions, restoring the originals if one write fails. */
  private writeDecisionSet(...decisions: DecisionEntry[]): void {
    const originals: { path: string; data: string }[] = [];
    for (const d of decisions) {
      if (
        !d ||
        !validDecisionId(d.id) ||
        !validDecisionStatus(d.status) ||
        !validDecisionReviewState(d.reviewState ?? "")
      ) {
        throw new Error("invalid decision transition payload");
      }
      const path = join(this.decisionsDir(), decisionFileName(d.id));
      let data: string;
      try {
        data = readFileSync(path, "utf8");
      } catch (e) {
        throw new Error(`snapshot decision "${d.id}": ${(e as Error).message}`);
      }
      originals.push({ path, data });
    }
    let written = 0;
    for (const [i, d] of decisions.entries()) {
      try {
        this.write((originals[i] as { path: string }).path, renderDecision(d));
      } catch (err) {
        let rollbackErr: unknown;
        for (let j = written - 1; j >= 0; j--) {
          const o = originals[j] as { path: string; data: string };
          try {
            atomicWrite(o.path, o.data);
          } catch (restoreErr) {
            rollbackErr ??= restoreErr;
          }
        }
        if (rollbackErr) {
          throw new Error(
            `write decision transition: ${(err as Error).message} (rollback failed: ${(rollbackErr as Error).message})`,
          );
        }
        throw new Error(`write decision transition: ${(err as Error).message}`);
      }
      written++;
    }
  }

  parseFile(abs: string): DecisionEntry {
    let data: string;
    try {
      data = readFileSync(abs, "utf8");
    } catch (e) {
      throw new Error(`parse decision ${abs}: ${(e as Error).message}`);
    }
    return parseDecisionContent(data);
  }
}
