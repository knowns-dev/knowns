// Go-vs-TS differential session for the tasks and docs tools: the same JSON-RPC calls against both
// servers, each in its own copy of the "full" fixture, compared after masking only wall-clock
// times, hashes, sandbox paths and generated task ids.
import { afterAll, describe, expect, test } from "bun:test";
import { firstDiff, hasGoBin, runDiff, type Step } from "./harness.ts";

const ID = /"(?:taskId|id)": "(FX-[0-9A-Z]{6})"|Created task (\S+)/;
const newId = /"taskId": "([A-Z]{2,8}-[0-9A-Z]{6})"/;

const steps: Step[] = [
  { tool: "tasks", args: { action: "list" }, normalize: sortJsonArray },
  { tool: "tasks", args: { action: "list", status: "done" }, normalize: sortJsonArray },
  { tool: "tasks", args: { action: "list", includeHistorical: true }, normalize: sortJsonArray },
  { tool: "tasks", args: { action: "list", label: "nope" } },
  { tool: "tasks", args: { action: "board" }, normalize: sortJsonArray },
  { tool: "tasks", args: { action: "get", taskId: "FX-19XJKQ" } },
  { tool: "tasks", args: { action: "get", taskId: "ZZ-NOPE" } },
  { tool: "tasks", args: { action: "get" } },
  { tool: "tasks", args: { action: "get", taskId: 5 } },
  { tool: "tasks", args: { action: "get", bogus: 1 } },
  { tool: "tasks", args: { action: "nope" } },
  { tool: "tasks", args: { action: "history", taskId: "FX-19XJKQ" } },
  { tool: "tasks", args: { action: "history", taskId: "FX-19XJKQ", metadata: true } },
  { tool: "tasks", args: { action: "history", taskId: "FX-19XJKQ", offset: -1 } },
  { tool: "tasks", args: { action: "history", taskId: "FX-19XJKQ", revision: "v1" } },
  { tool: "tasks", args: { action: "delete", taskId: "FX-19XJKQ" } },
  { tool: "tasks", args: { action: "delete", taskId: "FX-19XJKQ", dryRun: false } },
  {
    tool: "tasks",
    args: {
      action: "create",
      title: "Port MCP",
      description: "d",
      labels: ["a", "b"],
      addAc: ["one", "two"],
      priority: "high",
      order: 3,
    },
    capture: { name: "t1", re: newId },
  },
  { tool: "tasks", args: (c) => ({ action: "get", taskId: c.v.t1 }) },
  { tool: "tasks", args: { action: "create" } },
  { tool: "tasks", args: { action: "create", title: "x", return: "bogus" } },
  {
    tool: "tasks",
    args: { action: "create", title: "Full", return: "full", status: "done" },
    capture: { name: "t2", re: /"id": "([A-Z]{2,8}-[0-9A-Z]{6})"/ },
  },
  {
    tool: "tasks",
    args: (c) => ({
      action: "update",
      taskId: c.v.t1,
      status: "in-progress",
      checkAc: [1],
      appendNotes: "n1",
    }),
  },
  {
    tool: "tasks",
    args: (c) => ({
      action: "update",
      taskId: c.v.t1,
      appendNotes: "n2",
      plan: "p",
      return: "full",
    }),
  },
  { tool: "tasks", args: (c) => ({ action: "update", taskId: c.v.t1, checkAc: [9] }) },
  {
    tool: "tasks",
    args: (c) => ({
      action: "update",
      taskId: c.v.t1,
      removeAc: [1],
      clear: ["plan"],
      labels: ["z"],
    }),
  },
  { tool: "tasks", args: (c) => ({ action: "update", taskId: c.v.t1, status: "done" }) },
  { tool: "tasks", args: (c) => ({ action: "update", taskId: c.v.t1, expectedHash: "bad" }) },
  { tool: "tasks", args: (c) => ({ action: "archive", taskId: c.v.t1 }) },
  { tool: "tasks", args: (c) => ({ action: "archive", taskId: c.v.t1, execute: true }) },
  { tool: "tasks", args: (c) => ({ action: "unarchive", taskId: c.v.t1, execute: true }) },
  { tool: "tasks", args: { action: "batch_archive" }, normalize: sortJsonArray },
  { tool: "tasks", args: { action: "batch_unarchive" } },
  { tool: "tasks", args: (c) => ({ action: "hard_delete", taskId: c.v.t1 }) },
  {
    tool: "tasks",
    args: (c) => ({ action: "hard_delete", taskId: c.v.t1, confirmed: true, reason: "r" }),
  },
  { tool: "tasks", args: { action: "restore", taskId: "FX-19XJKQ" } },
  { tool: "tasks", args: { action: "restore", taskId: "FX-19XJKQ", execute: true } },

  { tool: "docs", args: { action: "list" } },
  { tool: "docs", args: { action: "list", tag: "nope" } },
  { tool: "docs", args: { action: "get" } },
  { tool: "docs", args: { action: "get", path: "nope" } },
  { tool: "docs", args: { action: "nope" } },
  {
    tool: "docs",
    args: {
      action: "create",
      title: "My New Doc",
      content: "# A\n\nx\n\n## B\n\ny",
      tags: ["t"],
      folder: "guides",
    },
  },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", toc: true } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", info: true } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", section: "B" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", section: "2" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", line: "1-3" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", line: "99" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", line: "x" } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", smart: true } },
  { tool: "docs", args: { action: "get", path: "guides/my-new-doc", includeHistory: true } },
  {
    tool: "docs",
    args: { action: "update", path: "guides/my-new-doc", appendContent: "tail", return: "full" },
  },
  {
    tool: "docs",
    args: { action: "update", path: "guides/my-new-doc", section: "B", content: "new b" },
  },
  {
    tool: "docs",
    args: { action: "update", path: "guides/my-new-doc", newPath: "guides/renamed", title: "R" },
  },
  { tool: "docs", args: { action: "history", path: "guides/renamed" } },
  { tool: "docs", args: { action: "history", path: "guides/renamed", metadata: true } },
  { tool: "docs", args: { action: "history", path: "guides/renamed", revision: "v1" } },
  { tool: "docs", args: { action: "diff", path: "guides/renamed" } },
  { tool: "docs", args: { action: "restore", path: "guides/renamed", revision: "v1" } },
  {
    tool: "docs",
    args: { action: "restore", path: "guides/renamed", revision: "v1", mode: "bad" },
  },
  { tool: "docs", args: { action: "restore", path: "guides/renamed" } },
  { tool: "docs", args: { action: "delete", path: "guides/renamed" } },
  { tool: "docs", args: { action: "delete", path: "guides/renamed", dryRun: false } },
  { tool: "docs", args: { action: "hard_delete", path: "guides/x" } },
  { tool: "docs", args: { action: "hard_delete", path: "guides/x", confirmed: true, reason: "r" } },
];

/** Go lists tasks in map order: compare lists and board columns by id instead. */
function sortJsonArray(text: string): string {
  const byId = (a: { id?: string }, b: { id?: string }) => (a.id ?? "").localeCompare(b.id ?? "");
  try {
    const v = JSON.parse(text);
    const subs = (t: { subtasks?: string[] }) => t.subtasks?.sort();
    if (Array.isArray(v)) {
      v.sort(byId);
      for (const t of v) subs(t);
    } else if (v && Array.isArray(v.columns)) {
      for (const c of v.columns) c.tasks.sort(byId);
      // Statuses outside the configured columns follow in Go map order.
      const rest = v.columns.splice(5);
      rest.sort((a: { status: string }, b: { status: string }) => a.status.localeCompare(b.status));
      v.columns.push(...rest);
    } else if (v && Array.isArray(v.results)) v.results.sort(byId);
    else if (v && Array.isArray(v.items)) {
      v.items.sort((a: { taskId: string }, b: { taskId: string }) =>
        a.taskId.localeCompare(b.taskId),
      );
    }
    return JSON.stringify(v, null, 2);
  } catch {
    return text;
  }
}
void ID;

describe.skipIf(!hasGoBin)("tasks and docs tools match Go", () => {
  let session: Awaited<ReturnType<typeof runDiff>> | undefined;
  afterAll(async () => {
    await session?.close();
  });
  test("session", async () => {
    session = await runDiff("full", steps);
    const diffs = session.results.filter((r) => r.goMasked !== r.tsMasked);
    if (diffs.length > 0) {
      const report = diffs
        .map((d) => `--- ${d.label}\n${firstDiff(d.goMasked, d.tsMasked)}`)
        .join("\n\n");
      console.log(report);
    }
    expect(diffs.length).toBe(0);
  }, 300_000);
});
