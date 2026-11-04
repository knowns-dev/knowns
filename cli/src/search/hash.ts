// Canonical content hashes for index validation (index.go contentHash and friends). A Qdrant point
// carries the hash of its source at indexing time; a hit is stale when today's hash differs, so
// these strings must match Go byte for byte.
import type { DecisionEntry } from "../models/decision.ts";
import { type Task, taskLifecycleState } from "../models/task.ts";
import { formatRFC3339NanoUTC } from "./time.ts";

export function contentHash(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function taskContentForHash(task: Task): string {
  let s = `${task.title}\n${task.description ?? ""}\n${task.status}\n${task.priority}\n${taskLifecycleState(task)}`;
  if (task.completedAt !== undefined) s += `\ncompleted:${formatRFC3339NanoUTC(task.completedAt)}`;
  if (task.archivedAt !== undefined) s += `\narchived:${formatRFC3339NanoUTC(task.archivedAt)}`;
  for (const ac of task.acceptanceCriteria ?? []) s += `\n${ac.text}`;
  s += `\n${task.implementationPlan ?? ""}\n${task.implementationNotes ?? ""}`;
  return s;
}

export function decisionContentForHash(decision: DecisionEntry): string {
  return [
    decision.title,
    decision.status,
    (decision.supersedes ?? []).join("\n"),
    (decision.supersededBy ?? []).join("\n"),
    (decision.tags ?? []).join("\n"),
    (decision.sources ?? []).join("\n"),
    (decision.relatedDocs ?? []).join("\n"),
    (decision.relatedTasks ?? []).join("\n"),
    decision.context ?? "",
    decision.decision ?? "",
    decision.alternativesConsidered ?? "",
    decision.consequences ?? "",
    decision.content ?? "",
  ].join("\n");
}
