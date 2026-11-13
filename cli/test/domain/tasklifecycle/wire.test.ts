import { describe, expect, test } from "bun:test";
import {
  eligibilityToWire,
  resultToWire,
  taskToWire,
  timeEntryToWire,
} from "../../../src/domain/tasklifecycle/index.ts";

describe("wire shapes follow Go's struct order and omitempty", () => {
  test("a task with nothing optional keeps labels/acceptanceCriteria as null", () => {
    const wire = taskToWire({
      id: "T",
      title: "t",
      status: "todo",
      priority: "low",
      labels: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archived: false,
      acceptanceCriteria: null,
      timeSpent: 0,
    });
    expect(Object.keys(wire)).toEqual([
      "id",
      "title",
      "status",
      "priority",
      "labels",
      "createdAt",
      "updatedAt",
      "archived",
      "acceptanceCriteria",
      "timeSpent",
    ]);
    expect(wire.labels).toBeNull();
    expect(wire.acceptanceCriteria).toBeNull();
  });

  test("a full task orders every optional field", () => {
    const wire = taskToWire({
      id: "T",
      title: "t",
      description: "d",
      status: "done",
      priority: "high",
      assignee: "a",
      labels: ["x"],
      parent: "P",
      subtasks: ["S"],
      spec: "s",
      fulfills: ["AC-1"],
      order: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-02T00:00:00Z",
      archivedAt: "2026-01-03T00:00:00Z",
      archived: true,
      acceptanceCriteria: [{ text: "ac", completed: true }],
      timeSpent: 5,
      timeEntries: [{ id: "te", startedAt: "2026-01-01T00:00:00Z", duration: 5, note: "n" }],
      activeTimer: { taskId: "T", startedAt: "x", pausedAt: null, totalPausedMs: 0 },
      canonicalHash: "h",
      implementationPlan: "p",
      implementationNotes: "n",
    });
    expect(Object.keys(wire)).toEqual([
      "id",
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "labels",
      "parent",
      "subtasks",
      "spec",
      "fulfills",
      "order",
      "createdAt",
      "updatedAt",
      "completedAt",
      "archivedAt",
      "archived",
      "acceptanceCriteria",
      "timeSpent",
      "timeEntries",
      "activeTimer",
      "canonicalHash",
      "implementationPlan",
      "implementationNotes",
    ]);
  });

  test("time entries and results omit empty optionals", () => {
    expect(Object.keys(timeEntryToWire({ id: "i", startedAt: "s", duration: 1 }))).toEqual([
      "id",
      "startedAt",
      "duration",
    ]);
    expect(
      Object.keys(
        resultToWire({
          taskId: "T",
          operation: "archive",
          changed: false,
          eligible: true,
          before: "done",
          after: "done",
          reasons: null,
        }),
      ),
    ).toEqual(["taskId", "operation", "changed", "eligible", "before", "after", "reasons"]);
    expect(
      eligibilityToWire({ taskId: "T", eligible: false, lifecycle: "active", reasons: [] }),
    ).toEqual({ taskId: "T", eligible: false, lifecycle: "active", reasons: [] });
  });
});
