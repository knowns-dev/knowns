// Port of internal/models/decision.go.
import { z } from "zod";
import { timestampSchema } from "./common.ts";

export const DECISION_STATUSES = [
  "draft",
  "accepted",
  "superseded",
  "rejected",
  "archived",
] as const;
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const DECISION_REVIEW_STATES = [
  "needs_evidence",
  "needs_resolution",
  "ready_for_review",
] as const;
export type DecisionReviewState = (typeof DECISION_REVIEW_STATES)[number];

/** Persisted summary of a current Decision that may duplicate or conflict with a draft. */
export const decisionReviewMatchSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().optional(),
  score: z.number(),
  kind: z.string().optional(),
  matchedBy: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Content hash of the matched decision as the reviewer saw it. */
  hash: z.string().optional(),
});
export type DecisionReviewMatch = z.infer<typeof decisionReviewMatchSchema>;

/** models.DecisionEntry (JSON shape; the body sections come from the markdown body). */
export const decisionEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  supersedes: z.array(z.string()).optional(),
  supersededBy: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  relatedDocs: z.array(z.string()).optional(),
  relatedTasks: z.array(z.string()).optional(),
  verification: z.array(z.string()).optional(),
  verifiedAt: timestampSchema.optional(),
  reviewState: z.string().optional(),
  reviewBlockers: z.array(z.string()).optional(),
  reviewMatches: z.array(decisionReviewMatchSchema).optional(),
  reviewAllowedResolutions: z.array(z.string()).optional(),
  reviewEvaluatedAt: timestampSchema.optional(),
  /** The content state the review was made against. */
  reviewEvaluatedHash: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  context: z.string().optional(),
  decision: z.string().optional(),
  alternativesConsidered: z.string().optional(),
  consequences: z.string().optional(),
  content: z.string().optional(),
});
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;

/** decisionFrontmatter in internal/storage/decision_store.go: timestamps are strings. */
export const decisionFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  supersedes: z.array(z.string()).nullish(),
  supersededBy: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  sources: z.array(z.string()).nullish(),
  relatedDocs: z.array(z.string()).nullish(),
  relatedTasks: z.array(z.string()).nullish(),
  verification: z.array(z.string()).nullish(),
  verifiedAt: z.string().optional(),
  reviewState: z.string().optional(),
  reviewBlockers: z.array(z.string()).nullish(),
  reviewMatches: z.array(decisionReviewMatchSchema).nullish(),
  reviewAllowedResolutions: z.array(z.string()).nullish(),
  reviewEvaluatedAt: z.string().optional(),
  reviewEvaluatedHash: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DecisionFrontmatter = z.infer<typeof decisionFrontmatterSchema>;

const DECISION_ID = /^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validDecisionStatus(status: string): status is DecisionStatus {
  return (DECISION_STATUSES as readonly string[]).includes(status);
}

/** "" is valid: a persisted candidate without a review state. */
export function validDecisionReviewState(state: string): boolean {
  return state === "" || (DECISION_REVIEW_STATES as readonly string[]).includes(state);
}

/** Canonical `YYYYMMDD-HHMM-slug` decision id. */
export function validDecisionId(id: string): boolean {
  return DECISION_ID.test(id);
}

/** CurrentForDefaultRetrieval: accepted, verified, and not superseded. */
export function decisionCurrentForDefaultRetrieval(
  d: Pick<DecisionEntry, "status" | "verifiedAt" | "supersededBy"> | null | undefined,
): boolean {
  if (!d) return false;
  return (
    d.status === "accepted" && d.verifiedAt !== undefined && (d.supersededBy?.length ?? 0) === 0
  );
}

/** CandidateForReviewInbox: a draft that still carries a review state. */
export function decisionCandidateForReviewInbox(
  d: Pick<DecisionEntry, "status" | "reviewState"> | null | undefined,
): boolean {
  if (d?.status !== "draft") return false;
  const state = d.reviewState ?? "";
  return validDecisionReviewState(state) && state !== "";
}

export function decisionRef(id: string): string {
  return `@decision/${id}`;
}

export function decisionFileName(id: string): string {
  return `${id}.md`;
}

/**
 * DecisionIDPrefix: `YYYYMMDD-HHMM` in the local time zone of the given instant (Go formats in the
 * Time's own location, which is Local for time.Now()). A missing instant means "now".
 */
export function decisionIdPrefix(createdAt?: Date): string {
  const d = createdAt ?? new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** DecisionSlug: lowercase, non-alphanumerics collapsed to `-`, trimmed; "decision" when empty. */
export function decisionSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "decision" : slug;
}

/** NewDecisionID: `prefix-slug`, with deterministic `-2`, `-3`... suffixes on collision. */
export function newDecisionId(
  title: string,
  createdAt: Date | undefined,
  exists?: (id: string) => boolean,
): string {
  const base = `${decisionIdPrefix(createdAt)}-${decisionSlug(title)}`;
  if (!exists?.(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
}
