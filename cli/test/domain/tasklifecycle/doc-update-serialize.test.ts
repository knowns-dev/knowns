// KN-V3GE5Q (docs): an update with a rebase and no expectedHash keeps concurrent edits, and a failure
// after the history append removes exactly that record.
import { afterAll, expect, test } from "bun:test";
import type { Doc } from "../../../src/models/doc.ts";
import { MutationConflictError, mutateDocWithHistory } from "../../../src/storage/history/index.ts";
import { cleanup, newEnv } from "./helpers.ts";

const e = newEnv();
afterAll(() => cleanup(e.dir));
const ctx = e.storage.ctx;

async function create(path: string): Promise<Doc> {
  const doc = { path, title: path, content: "# t\n\nbody" } as Doc;
  await mutateDocWithHistory(ctx, null, doc, { actor: "t", source: "test" });
  return e.storage.docs.get(path);
}
const append = (text: string) => (d: Doc) => {
  d.content = `${d.content ?? ""}\n${text}`;
};
const revisions = async (id: string) =>
  ((await ctx.versions.historyStore().read("doc", id)).records ?? []).length;

test("concurrent rebased updates without a hash all apply, one revision each", async () => {
  const doc = await create("hot-a");
  const n = 10;
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => {
      const old = { ...e.storage.docs.get("hot-a") };
      const next = { ...old };
      const edit = append(`n${i}`);
      edit(next);
      return mutateDocWithHistory(ctx, old, next, { actor: "t", source: "test", rebase: edit });
    }),
  );
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
  const content = e.storage.docs.get("hot-a").content ?? "";
  for (let i = 0; i < n; i++) expect(content).toContain(`n${i}`);
  expect(await revisions(doc.id as string)).toBe(1 + n);
});

test("an explicit stale expectedHash is still a conflict", async () => {
  const doc = await create("hot-b");
  const old = { ...doc };
  await mutateDocWithHistory(
    ctx,
    { ...doc },
    { ...doc, content: "# t\n\nchanged" },
    { actor: "t", source: "test" },
  );
  const next = { ...old };
  append("x")(next);
  await expect(
    mutateDocWithHistory(ctx, old, next, { actor: "t", source: "test", expectedHash: "deadbeef" }),
  ).rejects.toBeInstanceOf(MutationConflictError);
});

test("a failure after the append removes that record and restores the file", async () => {
  const doc = await create("hot-c");
  const before = await revisions(doc.id as string);
  const versions = ctx.versions;
  const original = versions.saveDocRevisionWithOptions.bind(versions);
  versions.saveDocRevisionWithOptions = async (...a: Parameters<typeof original>) => {
    await original(...a);
    throw new Error("sync history directory: injected");
  };
  const old = { ...e.storage.docs.get("hot-c") };
  const next = { ...old };
  append("lost")(next);
  await expect(
    mutateDocWithHistory(ctx, old, next, { actor: "t", source: "test" }),
  ).rejects.toThrow(/injected/);
  versions.saveDocRevisionWithOptions = original;
  expect(await revisions(doc.id as string)).toBe(before);
  expect(e.storage.docs.get("hot-c").content).not.toContain("lost");
  const again = { ...e.storage.docs.get("hot-c") };
  const next2 = { ...again };
  append("ok")(next2);
  await mutateDocWithHistory(ctx, again, next2, { actor: "t", source: "test" });
  expect(await revisions(doc.id as string)).toBe(before + 1);
});
