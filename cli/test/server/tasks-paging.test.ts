// KN-F1DQ03: GET /api/tasks keeps its unpaged shape for old UIs and adds summary=true, limit, cursor
// and filters. Seeded with the shared server harness, so it needs the oracle build like its siblings.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { hasGoBin, type Side, seedTemplate, send, startSide, stopSide } from "./harness.ts";

setDefaultTimeout(120_000);

const J = { "Content-Type": "application/json" };
let ts: Side;
const N = 130;

beforeAll(async () => {
  if (!hasGoBin) return;
  ts = await startSide("ts", seedTemplate());
  for (let i = 0; i < N; i++) {
    const r = await send(ts, "POST", "/api/tasks", {
      body: JSON.stringify({
        title: `Paged ${String(i).padStart(3, "0")}`,
        description: "long description ".repeat(30),
        status: i % 2 ? "todo" : "in-progress",
        implementationNotes: "notes",
      }),
      headers: J,
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`create ${i}: ${r.status} ${r.text}`);
  }
});
afterAll(() => {
  if (ts) stopSide(ts);
});

interface Wire {
  id: string;
  title: string;
  description?: string;
  implementationNotes?: string;
  descriptionPreview?: string;
  timeEntries?: unknown[];
  status: string;
}

describe.skipIf(!hasGoBin)("GET /api/tasks paging", () => {
  test("the unpaged call still returns every task in full as a bare array", async () => {
    const r = await send(ts, "GET", "/api/tasks");
    const all = JSON.parse(r.text) as Wire[];
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBe(N);
    expect(all[0]?.description).toBeDefined();
  });

  test("summary=true drops description, notes, plan and time entries", async () => {
    const full = await send(ts, "GET", "/api/tasks");
    const r = await send(ts, "GET", "/api/tasks?summary=true");
    const all = JSON.parse(r.text) as Wire[];
    expect(all.length).toBe(N);
    expect(
      all.every((t) => t.description === undefined && t.implementationNotes === undefined),
    ).toBe(true);
    expect(all.every((t) => t.timeEntries === undefined)).toBe(true);
    expect(all[0]?.descriptionPreview?.length).toBeLessThanOrEqual(140);
    expect(r.text.length).toBeLessThan(full.text.length * 0.7);
  });

  test("limit and cursor page through every task once, summary or full", async () => {
    for (const extra of ["&summary=true", ""]) {
      const seen: string[] = [];
      let cursor = "";
      for (let i = 0; i < 20; i++) {
        const r = await send(ts, "GET", `/api/tasks?limit=50${extra}${cursor}`);
        const page = JSON.parse(r.text) as { tasks: Wire[]; total: number; nextCursor?: string };
        expect(page.total).toBe(N);
        seen.push(...page.tasks.map((t) => t.id));
        if (!page.nextCursor) break;
        cursor = `&cursor=${encodeURIComponent(page.nextCursor)}`;
      }
      expect(seen.length).toBe(N);
      expect(new Set(seen).size).toBe(N);
    }
  });

  test("filters apply before paging; bad limit and cursor are 400", async () => {
    const r = await send(ts, "GET", "/api/tasks?status=todo&limit=10&summary=true");
    const page = JSON.parse(r.text) as { tasks: Wire[]; total: number };
    expect(page.total).toBe(N / 2);
    expect(page.tasks.length).toBe(10);
    expect(page.tasks.every((t) => t.status === "todo")).toBe(true);
    expect((await send(ts, "GET", "/api/tasks?limit=0")).status).toBe(400);
    expect((await send(ts, "GET", "/api/tasks?limit=5&cursor=zzz")).status).toBe(400);
  });
});
