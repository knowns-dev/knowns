// How Go marshals models.DecisionEntry and the decisionreview Result.
import type { DecisionEntry, DecisionReviewMatch } from "../../models/decision.ts";
import { type JsonObject, type Spec, shapeStruct } from "../../storage/stores/go-shape.ts";

const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

const REVIEW_MATCH_SPEC: Spec = [
  ["id", { req: "" }],
  ["title", { req: "" }],
  ["status", "str"],
  ["score", { req: 0 }],
  ["kind", "str"],
  ["matchedBy", "list"],
  ["snippet", "str"],
  ["tags", "list"],
  ["hash", "str"],
];

const DECISION_SPEC: Spec = [
  ["id", { req: "" }],
  ["title", { req: "" }],
  ["status", { req: "" }],
  ["supersedes", "list"],
  ["supersededBy", "list"],
  ["tags", "list"],
  ["sources", "list"],
  ["relatedDocs", "list"],
  ["relatedTasks", "list"],
  ["verification", "list"],
  ["verifiedAt", "ptr"],
  ["reviewState", "str"],
  ["reviewBlockers", "list"],
  ["reviewMatches", "list"],
  ["reviewAllowedResolutions", "list"],
  ["reviewEvaluatedAt", "ptr"],
  ["reviewEvaluatedHash", "str"],
  ["createdAt", { req: GO_ZERO_TIME }],
  ["updatedAt", { req: GO_ZERO_TIME }],
  ["context", "str"],
  ["decision", "str"],
  ["alternativesConsidered", "str"],
  ["consequences", "str"],
  ["content", "str"],
];

export function reviewMatchJson(m: DecisionReviewMatch): JsonObject {
  return shapeStruct(m as unknown as JsonObject, REVIEW_MATCH_SPEC);
}

/** The JSON object Go would marshal for a DecisionEntry. */
export function decisionJson(entry: DecisionEntry): JsonObject {
  const out = shapeStruct(entry as unknown as JsonObject, DECISION_SPEC);
  if (Array.isArray(out.reviewMatches)) {
    out.reviewMatches = (out.reviewMatches as DecisionReviewMatch[]).map(reviewMatchJson);
  }
  return out;
}

export interface DecisionMatch {
  id: string;
  title: string;
  status?: string;
  score: number;
  kind?: string;
  matchedBy?: string[];
  snippet?: string;
  tags?: string[];
  /** Pins the matched decision's content as the reviewer saw it. */
  hash?: string;
}

export interface DecisionReviewResult {
  status: "created" | "review_required" | "resolved";
  resolution?: string;
  candidate?: DecisionEntry;
  matches?: DecisionMatch[];
  allowedResolutions?: string[];
  decision?: DecisionEntry;
  superseded?: DecisionEntry;
  current?: DecisionEntry;
  changedIds?: string[];
  supersededDecisions?: DecisionEntry[];
  pendingVerification?: boolean;
}

/** The JSON object Go would marshal for a decisionreview.Result. */
export function decisionResultJson(r: DecisionReviewResult): JsonObject {
  const out: JsonObject = { status: r.status };
  if (r.resolution) out.resolution = r.resolution;
  if (r.candidate) out.candidate = decisionJson(r.candidate);
  if (r.matches && r.matches.length > 0) {
    out.matches = r.matches.map((m) => shapeStruct(m as unknown as JsonObject, REVIEW_MATCH_SPEC));
  }
  if (r.allowedResolutions && r.allowedResolutions.length > 0) {
    out.allowedResolutions = r.allowedResolutions;
  }
  if (r.decision) out.decision = decisionJson(r.decision);
  if (r.superseded) out.superseded = decisionJson(r.superseded);
  if (r.current) out.current = decisionJson(r.current);
  if (r.changedIds && r.changedIds.length > 0) out.changedIds = r.changedIds;
  if (r.supersededDecisions && r.supersededDecisions.length > 0) {
    out.supersededDecisions = r.supersededDecisions.map(decisionJson);
  }
  if (r.pendingVerification) out.pendingVerification = true;
  return out;
}
