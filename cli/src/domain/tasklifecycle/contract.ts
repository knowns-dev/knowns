// Port of internal/tasklifecycle/contract.go: the single public failure classification used by CLI,
// MCP and HTTP adapters after a lifecycle Response has been built.
import { HistoryConflictError, MutationConflictError } from "../../storage/history/index.ts";
import { findError } from "./errors.ts";
import type { Reason, ReasonCode, Request, Response } from "./types.ts";

export type FailureKind =
  | ""
  | "invalid_request"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "business_denied"
  | "operation_failed";

export const FailureNone: FailureKind = "";
export const FailureInvalidRequest: FailureKind = "invalid_request";
export const FailurePermission: FailureKind = "permission_denied";
export const FailureNotFound: FailureKind = "not_found";
export const FailureConflict: FailureKind = "conflict";
export const FailureDenied: FailureKind = "business_denied";
export const FailureOperation: FailureKind = "operation_failed";

/** The failure of a public lifecycle request, with its classification. */
export class ContractError extends Error {
  override readonly name = "ContractError";
  constructor(
    readonly kind: FailureKind,
    cause: Error,
  ) {
    super(cause.message, { cause });
  }
}

const isConflict = (e: Error): e is MutationConflictError | HistoryConflictError =>
  e instanceof MutationConflictError || e instanceof HistoryConflictError;

/**
 * Deterministically classifies a response. Preview eligibility reasons are informational;
 * execute-time denials are failures. Idempotent already_* reasons remain successful on both paths.
 */
export function failureKindFor(response: Response | undefined, cause?: Error): FailureKind {
  if (!response) return FailureOperation;
  if (cause && findError(cause, isConflict)) return FailureConflict;
  let best: FailureKind = FailureNone;
  for (const item of response.items) {
    for (const reason of item.reasons ?? []) {
      const kind = failureKindForReason(reason.code, response.execute);
      if (failurePriority(kind) > failurePriority(best)) best = kind;
    }
  }
  if (best !== FailureNone) return best;
  if (cause) return FailureOperation;
  return FailureNone;
}

/** The ContractError for a response, or undefined when it succeeded. */
export function contractError(response: Response, cause?: Error): ContractError | undefined {
  const kind = failureKindFor(response, cause);
  if (kind === FailureNone) return undefined;
  return new ContractError(kind, cause ?? new Error(`Task lifecycle request failed: ${kind}`));
}

function failureKindForReason(code: ReasonCode, execute: boolean): FailureKind {
  switch (code) {
    case "invalid_request":
    case "confirmation_required":
    case "delete_reason_required":
      return FailureInvalidRequest;
    case "permission_required":
      return FailurePermission;
    case "not_found":
      return FailureNotFound;
    case "tombstone_conflict":
      return FailureConflict;
    case "operation_failed":
      return FailureOperation;
    case "already_archived":
    case "already_active":
    case "already_deleted":
      return FailureNone;
    default:
      return execute ? FailureDenied : FailureNone;
  }
}

function failurePriority(kind: FailureKind): number {
  switch (kind) {
    case FailurePermission:
      return 6;
    case FailureInvalidRequest:
      return 5;
    case FailureNotFound:
      return 4;
    case FailureConflict:
      return 3;
    case FailureDenied:
      return 2;
    case FailureOperation:
      return 1;
    default:
      return 0;
  }
}

const blank = (s: string | undefined): boolean => (s ?? "").trim() === "";

/** validatePublicRequest: the shape check every adapter shares; undefined when valid. */
export function validatePublicRequest(request: Request): Reason | undefined {
  const invalid = (message: string): Reason => ({ code: "invalid_request", message });
  switch (request.operation) {
    case "archive":
    case "reopen":
    case "hard_delete":
      if (blank(request.taskId)) return invalid("taskId is required");
      break;
    case "batch_archive":
      for (const id of request.ids ?? []) {
        if (blank(id)) return invalid("batch Task IDs must be non-empty");
      }
      break;
    case "batch_unarchive":
      if ((request.ids ?? []).length === 0) return invalid("ids must contain at least one Task ID");
      for (const id of request.ids ?? []) {
        if (blank(id)) return invalid("batch Task IDs must be non-empty");
      }
      break;
    default:
      return invalid(`unsupported Task lifecycle operation ${JSON.stringify(request.operation)}`);
  }
  return undefined;
}
