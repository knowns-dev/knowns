// KN-V3GE5Q review P2-2: a hash-less section update re-applied under the lock must still address the
// same section; otherwise it is a conflict, never a silent no-op or a write to another section.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { handle as docHandle } from "../../src/mcp/handlers/doc.ts";
import { McpLogger } from "../../src/mcp/log.ts";
import { McpState } from "../../src/mcp/state.ts";
import { copyFixture, storeAt } from "../stores/helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function setup(content: string) {
  const { project, root } = copyFixture("full");
  roots.push(root);
  const state = new McpState(new McpLogger(process.pid, () => {}));
  await state.setProject(storeAt(project), project);
  const storage = (state.getProject() as NonNullable<ReturnType<McpState["getProject"]>>).storage;
  const call = (args: Record<string, unknown>) => docHandle(state, {}, { name: "x", args, id: 1 });
  const made = await call({ action: "create", title: "Sec doc", content });
  expect(made.isError).toBe(false);
  const path = "sec-doc";
  // A concurrent writer changes the document while the update waits for the document lock.
  const concurrently = async (newContent: string, update: Record<string, unknown>) => {
    const ctx = storage.ctx;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => {
      locked = r;
    });
    const holder = storage.store.withDocMutationLocks(
      [path],
      async () => {
        locked();
        await held;
      },
      { timeoutMs: 5000 },
    );
    await lockedP;
    const pending = call({ action: "update", path, ...update });
    await new Promise((r) => setTimeout(r, 150));
    const before = { ...storage.docs.get(path) };
    const after = { ...before, content: newContent };
    await ctx.docs.update(after);
    await ctx.versions.saveDocRevisionWithOptions(before, after, { actor: "t", source: "test" });
    release();
    await holder;
    return pending;
  };
  return { storage, path, concurrently };
}

test("a title section that still exists is rebased and the concurrent edit is kept", async () => {
  const s = await setup("# A\n\none\n\n## B\n\ntwo\n");
  const res = await s.concurrently("# A\n\none\n\nadded by someone else\n\n## B\n\ntwo\n", {
    section: "B",
    content: "## B\n\nnew two",
  });
  expect(res.isError).toBe(false);
  const text = s.storage.docs.get(s.path).content ?? "";
  expect(text).toContain("added by someone else");
  expect(text).toContain("new two");
});

test("a title section that disappeared is a conflict, not a silent success", async () => {
  const s = await setup("# A\n\none\n\n## B\n\ntwo\n");
  const res = await s.concurrently("# A\n\none\n", { section: "B", content: "## B\n\nnew two" });
  expect(res.isError).toBe(true);
  expect(res.text).toMatch(/no longer exists/);
  expect(s.storage.docs.get(s.path).content).not.toContain("new two");
});

test("a numeric section is never rebased onto a changed document", async () => {
  const s = await setup("# A\n\none\n\n## B\n\ntwo\n");
  const res = await s.concurrently("# New first\n\nx\n\n# A\n\none\n\n## B\n\ntwo\n", {
    section: "2",
    content: "## B\n\nnew two",
  });
  expect(res.isError).toBe(true);
  expect(res.text).toMatch(/section index cannot be re-applied/);
});
