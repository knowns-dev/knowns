// KN-6DVWN6: MCP tasks list and board return summaries, page with a cursor, filter before paging.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { handle as taskHandle } from "../../src/mcp/handlers/task.ts";
import { McpLogger } from "../../src/mcp/log.ts";
import { McpState } from "../../src/mcp/state.ts";
import { copyFixture, storeAt } from "../stores/helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface Summary {
  id: string;
  title: string;
  description?: string;
  status: string;
  labels: string[];
}
interface Page {
  results: Summary[];
  total: number;
  limit: number;
  nextCursor?: string;
}
interface Board {
  columns: { status: string; tasks: Summary[]; count: number; nextCursor?: string }[];
  total: number;
  limit: number;
}

async function project(n: number) {
  const { project: p, root } = copyFixture("full");
  roots.push(root);
  const state = new McpState(new McpLogger(process.pid, () => {}));
  await state.setProject(storeAt(p), p);
  const call = async (args: Record<string, unknown>) =>
    taskHandle(state, {}, { name: "tasks", args, id: 1 });
  for (let i = 0; i < n; i++) {
    const r = await call({
      action: "create",
      title: `Bulk ${String(i).padStart(3, "0")} widget`,
      description: `${"long description ".repeat(40)} ${i % 2 ? "odd" : "even"}`,
      status: i % 4 === 0 ? "done" : "todo",
      labels: i % 3 === 0 ? ["three"] : [],
    });
    expect(r.isError).toBe(false);
  }
  const list = async (args: Record<string, unknown> = {}) => {
    const r = await call({ action: "list", ...args });
    return { r, page: r.isError ? undefined : (JSON.parse(r.text) as Page) };
  };
  return { call, list };
}

describe("tasks list", () => {
  test("defaults to a small page of summaries without descriptions", async () => {
    const { list } = await project(120);
    const { r, page } = await list();
    expect(page?.results.length).toBe(50);
    expect(page?.limit).toBe(50);
    expect((page?.total ?? 0) >= 120).toBe(true);
    expect(page?.nextCursor).toBeDefined();
    expect(page?.results.every((t) => t.description === undefined)).toBe(true);
    expect(r.text.length).toBeLessThan(20_000);
  });

  test("following nextCursor visits every task once, in a stable order", async () => {
    const { list } = await project(75);
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const { page } = await list({ limit: 20, ...(cursor ? { cursor } : {}) });
      total = page?.total ?? 0;
      seen.push(...(page?.results.map((t) => t.id) ?? []));
      cursor = page?.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    const again = await list({ limit: 200 });
    expect(again.page?.results.map((t) => t.id)).toEqual(seen);
  });

  test("filters apply before paging", async () => {
    const { list } = await project(60);
    const done = await list({ status: "done", limit: 5 });
    expect(done.page?.results.length).toBe(5);
    expect(done.page?.results.every((t) => t.status === "done")).toBe(true);
    const all = await list({ status: "done", limit: 200 });
    expect(done.page?.total).toBe(all.page?.total);
    const q = await list({ query: "bulk 007 widget" });
    expect(q.page?.total).toBe(1);
    const odd = await list({ query: "odd", limit: 200 });
    expect(odd.page?.total).toBe(30);
    const label = await list({ label: "three", limit: 200 });
    expect(label.page?.results.every((t) => t.labels.includes("three"))).toBe(true);
  });

  test("detail=full keeps the full fields, limit is clamped, a bad cursor is an error", async () => {
    const { list } = await project(10);
    const full = await list({ detail: "full", query: "bulk", limit: 3 });
    expect(full.page?.results.length).toBe(3);
    expect(full.page?.results[0]?.description).toBeDefined();
    const huge = await list({ limit: 100000 });
    expect(huge.page?.limit).toBe(200);
    const bad = await list({ cursor: "nonsense" });
    expect(bad.r.isError).toBe(true);
    const detail = await list({ detail: "weird" });
    expect(detail.r.isError).toBe(true);
  });
});

describe("tasks board", () => {
  test("returns the first page of summaries per column with the full count", async () => {
    const { call } = await project(100);
    const res = await call({ action: "board" });
    expect(res.isError).toBe(false);
    expect(res.text.length).toBeLessThan(20_000 * 2);
    const board = JSON.parse(res.text) as Board;
    expect(board.limit).toBe(20);
    const todo = board.columns.find((c) => c.status === "todo");
    expect(todo?.tasks.length).toBe(20);
    expect((todo?.count ?? 0) > 20).toBe(true);
    expect(todo?.nextCursor).toBeDefined();
    expect(todo?.tasks.every((t) => t.description === undefined)).toBe(true);
  });

  test("status plus cursor pages one column; cursor without status is refused", async () => {
    const { call } = await project(60);
    const first = JSON.parse(
      (await call({ action: "board", status: "todo", limit: 10 })).text,
    ) as Board;
    expect(first.columns.length).toBe(1);
    const col = first.columns[0];
    const next = JSON.parse(
      (await call({ action: "board", status: "todo", limit: 10, cursor: col?.nextCursor })).text,
    ) as Board;
    const ids = new Set(
      [...(col?.tasks ?? []), ...(next.columns[0]?.tasks ?? [])].map((t) => t.id),
    );
    expect(ids.size).toBe(20);
    const bad = await call({ action: "board", cursor: col?.nextCursor });
    expect(bad.isError).toBe(true);
  });
});
