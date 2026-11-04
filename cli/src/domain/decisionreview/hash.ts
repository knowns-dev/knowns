// CanonicalDecisionHash and DecisionReviewIsStale (internal/storage/decision_store.go).
import type { DecisionEntry } from "../../models/decision.ts";
import { hashSnapshot } from "../../storage/history/entities.ts";
import { canonicalDecisionSnapshot } from "../../storage/stores/decision-store.ts";

/**
 * The content hash a review records. Review fields, timestamps and the ID are deliberately absent,
 * so writing a review cannot change the state it judged.
 */
export function canonicalDecisionHash(entry: DecisionEntry | null | undefined): string {
  if (!entry) return "";
  return hashSnapshot(canonicalDecisionSnapshot(entry));
}

/** Whether a recorded review was made against a state the decision has since left. */
export function decisionReviewIsStale(entry: DecisionEntry | null | undefined): boolean {
  if (!entry?.reviewEvaluatedHash) return false;
  return entry.reviewEvaluatedHash !== canonicalDecisionHash(entry);
}
