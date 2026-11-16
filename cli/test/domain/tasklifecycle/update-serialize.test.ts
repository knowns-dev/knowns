// KN-V3GE5Q: updates without an expectedHash serialize instead of conflicting, an explicit stale
// hash still conflicts, and a failed update leaves no history record.
import { afterAll, describe, expect, test } from "bun:test";
import { MutationConflictError } from "../../../src/storage/history/index.ts";
import { addTask, cleanup, newEnv } from "./helpers.ts";

const envs: string[] = [];
function env() {
  const e = newEnv();
  envs.push(e.dir);
  return e;
}
afterAll(() => cleanup(...envs));

const note = (text: string) => ({
  mutate: (t: { implementationNotes?: string }) => {
    t.implementationNotes = t.implementationNotes ? `${t.implementationNotes}\n${text}` : text;
  },
});

describe("update without expectedHash", () => {
  test("concurrent updates all succeed, none lost, one history record each", async () => {
    const e = env();
    const t = await addTask(e, "hot");
    const n = 12;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => e.service.updateTask(t.id, note(`n${i}`))),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const notes = e.storage.tasks.get(t.id).implementationNotes ?? "";
    expect(notes.split("\n").sort()).toEqual(Array.from({ length: n }, (_, i) => `n${i}`).sort());
    const history = await e.storage.versions.getHistory(t.id);
    expect(history.versions).toHaveLength(1 + n);
  });

  test("an explicit stale expectedHash is still a conflict and leaves no record", async () => {
    const e = env();
    const t = await addTask(e, "stale");
    const stale = e.service.observedTaskHash(t.id);
    await e.service.updateTask(t.id, note("first"));
    const before = (await e.storage.versions.getHistory(t.id)).versions?.length;
    await expect(
      e.service.updateTask(t.id, { expectedHash: stale, ...note("second") }),
    ).rejects.toBeInstanceOf(MutationConflictError);
    expect((await e.storage.versions.getHistory(t.id)).versions?.length).toBe(before);
    expect(e.storage.tasks.get(t.id).implementationNotes).toBe("first");
  });
});

describe("a failure after the history append", () => {
  test("removes the appended record, restores the task, and the history still verifies", async () => {
    const e = env();
    const t = await addTask(e, "fail");
    await e.service.updateTask(t.id, note("kept"));
    const versions = e.storage.ctx.versions;
    const original = versions.saveVersionUnlocked.bind(versions);
    versions.saveVersionUnlocked = async (id: string, v: never) => {
      await original(id, v); // the record lands...
      throw new Error("sync history directory: injected"); // ...then the step fails
    };
    await expect(e.service.updateTask(t.id, note("lost"))).rejects.toThrow(/injected/);
    versions.saveVersionUnlocked = original;
    const history = await e.storage.versions.getHistory(t.id); // verifies the chain, throws if corrupt
    expect(history.versions).toHaveLength(2);
    expect(e.storage.tasks.get(t.id).implementationNotes).toBe("kept");
    await e.service.updateTask(t.id, note("after")); // and later writes chain on
    expect((await e.storage.versions.getHistory(t.id)).versions).toHaveLength(3);
  });

  test("removeTailIfOwn truncates nothing when another record landed after ours", async () => {
    const e = env();
    const t = await addTask(e, "foreign");
    const store = e.storage.ctx.versions.historyStore();
    await e.service.updateTask(t.id, note("a"));
    await e.service.updateTask(t.id, note("b"));
    const read = await store.read("task", t.id);
    const ownHashOfMiddle = (read.records ?? [])[1]?.newHash as string;
    // the stream is 3 records; asking to drop "ours" at length 1 while the tail is not it must refuse
    expect(await store.removeTailIfOwn("task", t.id, 1, ownHashOfMiddle)).toBe(false);
    expect((await store.read("task", t.id)).records ?? []).toHaveLength(3);
  });
});
