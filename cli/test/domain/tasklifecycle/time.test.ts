import { afterAll, describe, expect, test } from "bun:test";
import { MutationConflictError } from "../../../src/storage/history/index.ts";
import type { Env } from "./helpers.ts";
import { addTask, cleanup, failure, newEnv } from "./helpers.ts";

const envs: string[] = [];
function env() {
  const e = newEnv();
  envs.push(e.dir);
  return e;
}
afterAll(() => cleanup(...envs));

/** Puts timers straight into time.json so durations are exact against the test clock (12:00). */
function setTimers(
  e: Env,
  timers: { taskId: string; startedAt: string; pausedAt?: string; paused?: number }[],
) {
  e.storage.time.saveStateUnlocked({
    active: timers.map((t) => ({
      taskId: t.taskId,
      startedAt: t.startedAt,
      pausedAt: t.pausedAt ?? null,
      totalPausedMs: t.paused ?? 0,
    })),
  });
}

describe("stopTimers", () => {
  test("a running timer becomes a completed entry, timeSpent and one lifecycle version", async () => {
    const e = env();
    const t = await addTask(e, "work");
    setTimers(e, [{ taskId: t.id, startedAt: "2026-06-01T11:00:00.000Z" }]);
    const entry = await e.service.stopTimer(t.id, { actor: "ann" });
    expect(entry).toEqual({
      id: `te-${e.clock.now.getTime()}-${t.id}`,
      startedAt: "2026-06-01T11:00:00Z",
      endedAt: "2026-06-01T12:00:00Z",
      duration: 3600,
    });
    expect(e.storage.time.getState().active).toEqual([]);
    expect(e.storage.time.getEntries(t.id)).toEqual([entry]);
    const stored = e.storage.tasks.get(t.id);
    expect(stored.timeSpent).toBe(3600);
    const last = (await e.storage.versions.getHistory(t.id)).versions?.at(-1);
    expect(last?.lifecycleEventId).toBe(
      `time-stop-${BigInt(e.clock.now.getTime()) * 1_000_000n}-${t.id}`,
    );
    expect(last?.author).toBe("ann");
  });

  test("paused time is excluded, including an open pause", async () => {
    const e = env();
    const a = await addTask(e, "a");
    const b = await addTask(e, "b");
    setTimers(e, [
      { taskId: a.id, startedAt: "2026-06-01T10:00:00Z", paused: 30 * 60 * 1000 },
      { taskId: b.id, startedAt: "2026-06-01T10:00:00Z", pausedAt: "2026-06-01T11:00:00Z" },
    ]);
    const entries = await e.service.stopTimers([b.id, a.id]);
    // Entries come back in task-id order; look each up by its task.
    const durationOf = (id: string) => entries.find((x) => x.id.endsWith(`-${id}`))?.duration;
    expect(durationOf(a.id)).toBe(90 * 60);
    expect(durationOf(b.id)).toBe(60 * 60);
    expect(entries.map((x) => x.id)).toEqual(
      [a.id, b.id].sort().map((id) => `te-${e.clock.now.getTime()}-${id}`),
    );
  });

  test("an unparseable start counts as one second, and a clock before the start never goes negative", async () => {
    const e = env();
    const a = await addTask(e, "a");
    const b = await addTask(e, "b");
    setTimers(e, [
      { taskId: a.id, startedAt: "garbage" },
      { taskId: b.id, startedAt: "2026-06-01T13:00:00Z" },
    ]);
    const entries = await e.service.stopTimers([a.id, b.id]);
    const durationOf = (id: string) => entries.find((x) => x.id.endsWith(`-${id}`))?.duration;
    expect(durationOf(a.id)).toBe(1);
    expect(durationOf(b.id)).toBe(0);
  });

  test("all selected timers stop together or not at all", async () => {
    const e = env();
    const a = await addTask(e, "a");
    const b = await addTask(e, "b");
    setTimers(e, [
      { taskId: a.id, startedAt: "2026-06-01T11:00:00Z" },
      { taskId: b.id, startedAt: "2026-06-01T11:00:00Z" },
    ]);
    const err = await failure(
      e.service.stopTimers([a.id, b.id], { expectedHashes: { [b.id]: "stale" } }),
    );
    expect(err).toBeInstanceOf(MutationConflictError);
    expect(e.storage.time.getState().active).toHaveLength(2);
    expect(e.storage.time.getEntries(a.id)).toEqual([]);
    expect(e.storage.tasks.get(a.id).timeSpent).toBe(0);
  });

  test("errors: no timer, blank id, archived task; an empty list is a no-op", async () => {
    const e = env();
    const a = await addTask(e, "a", { status: "done" });
    await expect(e.service.stopTimer(a.id)).rejects.toThrow(`no active timer for task "${a.id}"`);
    await expect(e.service.stopTimers(["  "])).rejects.toThrow("task ID is required");
    expect(await e.service.stopTimers([])).toEqual([]);
    setTimers(e, [{ taskId: a.id, startedAt: "2026-06-01T11:00:00Z" }]);
    await e.service.archive(a.id).catch(() => undefined);
    // The timer blocks archival, so the task is still active and the stop works.
    expect(e.storage.tasks.get(a.id).archived).toBe(false);
    await expect(e.service.stopTimer("missing")).rejects.toThrow("not found");
  });
});

describe("addTimeEntry", () => {
  const entry = (extra: object = {}) => ({
    id: "te-1-x",
    startedAt: "2026-05-01T09:00:00Z",
    duration: 5400,
    ...extra,
  });

  test("appends the entry, derives endedAt, bumps timeSpent and records a version", async () => {
    const e = env();
    const t = await addTask(e, "work");
    const out = await e.service.addTimeEntry(t.id, { actor: "ann", entry: entry({ note: "n" }) });
    expect(out).toEqual({
      id: "te-1-x",
      startedAt: "2026-05-01T09:00:00Z",
      endedAt: "2026-05-01T10:30:00Z",
      duration: 5400,
      note: "n",
    });
    expect(e.storage.time.getEntries(t.id)).toEqual([out]);
    expect(e.storage.tasks.get(t.id).timeSpent).toBe(5400);
    expect((await e.storage.versions.getHistory(t.id)).versions?.at(-1)?.author).toBe("ann");
  });

  test("an empty id and start default from the clock", async () => {
    const e = env();
    const t = await addTask(e, "work");
    const out = await e.service.addTimeEntry(t.id, {
      entry: { id: "", startedAt: "", duration: 60 },
    });
    expect(out.id).toBe(`te-${BigInt(e.clock.now.getTime()) * 1_000_000n}-${t.id}`);
    expect(out.startedAt).toBe("2026-06-01T12:00:00Z");
    expect(out.endedAt).toBe("2026-06-01T12:01:00Z");
  });

  test("the same entry twice is recorded once; the same id with other content is refused", async () => {
    const e = env();
    const t = await addTask(e, "work");
    await e.service.addTimeEntry(t.id, { entry: entry() });
    const again = await e.service.addTimeEntry(t.id, { entry: entry() });
    expect(again.duration).toBe(5400);
    expect(e.storage.time.getEntries(t.id)).toHaveLength(1);
    expect(e.storage.tasks.get(t.id).timeSpent).toBe(5400);
    await expect(e.service.addTimeEntry(t.id, { entry: entry({ duration: 60 }) })).rejects.toThrow(
      'time entry "te-1-x" already exists with different content',
    );
  });

  test("validation, archived tasks and stale hashes", async () => {
    const e = env();
    const t = await addTask(e, "work");
    await expect(e.service.addTimeEntry(t.id, { entry: entry({ duration: -1 }) })).rejects.toThrow(
      "time entry duration must be non-negative",
    );
    expect(
      await failure(e.service.addTimeEntry(t.id, { entry: entry(), expectedHash: "stale" })),
    ).toBeInstanceOf(MutationConflictError);
    expect(e.storage.time.getEntries(t.id)).toEqual([]);
    const done = await addTask(e, "done", { status: "done" });
    await e.service.archive(done.id);
    await expect(e.service.addTimeEntry(done.id, { entry: entry() })).rejects.toThrow(
      `cannot mutate time for archived Task "${done.id}"`,
    );
  });
});
