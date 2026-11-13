import { describe, expect, test } from "bun:test";
import {
  ContractError,
  contractError,
  type FailureKind,
  failureKindFor,
  JoinedError,
  type Reason,
  type Response,
  validatePublicRequest,
} from "../../../src/domain/tasklifecycle/index.ts";
import { MutationConflictError } from "../../../src/storage/history/index.ts";

const response = (execute: boolean, ...codes: Reason["code"][]): Response => ({
  operation: "archive",
  execute,
  completed: false,
  processed: 1,
  changed: 0,
  items: [
    {
      taskId: "T",
      operation: "archive",
      changed: false,
      eligible: false,
      before: "active",
      after: "active",
      reasons: codes.map((code) => ({ code, message: code })),
    },
  ],
});

describe("failureKindFor", () => {
  test("business reasons deny on execute and inform on preview", () => {
    for (const code of [
      "not_done",
      "active_timer",
      "unfinished_descendant",
      "retention_pending",
    ] as const) {
      expect(failureKindFor(response(true, code))).toBe("business_denied");
      expect(failureKindFor(response(false, code))).toBe("");
    }
  });

  test("idempotent already_* reasons never fail", () => {
    for (const code of ["already_archived", "already_active", "already_deleted"] as const) {
      expect(failureKindFor(response(true, code))).toBe("");
    }
  });

  test("the most severe reason wins: permission > invalid > not_found > conflict > denied > operation", () => {
    const order: [Reason["code"], FailureKind][] = [
      ["permission_required", "permission_denied"],
      ["invalid_request", "invalid_request"],
      ["not_found", "not_found"],
      ["tombstone_conflict", "conflict"],
      ["not_done", "business_denied"],
      ["operation_failed", "operation_failed"],
    ];
    for (let i = 0; i < order.length; i++) {
      const rest = order.slice(i).map(([code]) => code);
      expect(failureKindFor(response(true, ...rest.reverse()))).toBe(order[i]?.[1] as FailureKind);
    }
    expect(failureKindFor(response(true, "confirmation_required"))).toBe("invalid_request");
    expect(failureKindFor(response(true, "delete_reason_required"))).toBe("invalid_request");
  });

  test("a stale-hash cause is a conflict, also inside a joined error; any other cause is an operation failure", () => {
    const conflict = new MutationConflictError("task", "T", "a", "b");
    expect(failureKindFor(response(true), conflict)).toBe("conflict");
    expect(failureKindFor(response(true), new JoinedError([new Error("x"), conflict]))).toBe(
      "conflict",
    );
    expect(failureKindFor(response(true), new Error("boom"))).toBe("operation_failed");
    expect(failureKindFor(undefined)).toBe("operation_failed");
  });

  test("contractError wraps the cause or names the kind", () => {
    expect(contractError(response(false, "not_done"))).toBeUndefined();
    const err = contractError(response(true, "not_done"));
    expect(err).toBeInstanceOf(ContractError);
    expect(err?.message).toBe("Task lifecycle request failed: business_denied");
    expect(contractError(response(true), new Error("disk full"))?.message).toBe("disk full");
  });
});

describe("validatePublicRequest", () => {
  test("accepts well-formed requests", () => {
    expect(
      validatePublicRequest({ operation: "archive", execute: true, taskId: "T" }),
    ).toBeUndefined();
    expect(validatePublicRequest({ operation: "batch_archive", execute: false })).toBeUndefined();
    expect(
      validatePublicRequest({ operation: "batch_unarchive", execute: false, ids: ["a"] }),
    ).toBeUndefined();
  });

  test("rejects the rest with Go's messages", () => {
    const msg = (r: Parameters<typeof validatePublicRequest>[0]) =>
      validatePublicRequest(r)?.message;
    expect(msg({ operation: "hard_delete", execute: true, taskId: " " })).toBe(
      "taskId is required",
    );
    expect(msg({ operation: "batch_archive", execute: true, ids: ["a", ""] })).toBe(
      "batch Task IDs must be non-empty",
    );
    expect(msg({ operation: "batch_unarchive", execute: true })).toBe(
      "ids must contain at least one Task ID",
    );
  });
});
