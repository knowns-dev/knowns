// SSE event sequences after the same mutations, Go server vs TS server.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { hasGoBin, mask, type Side, seedTemplate, send, startSide, stopSide } from "./harness.ts";

// Starting two servers (and the Go init) is slow on Windows; hooks get the same budget as tests.
setDefaultTimeout(120_000);

const J = { "Content-Type": "application/json" };
let go: Side;
let ts: Side;

beforeAll(async () => {
  if (!hasGoBin) return;
  const tpl = seedTemplate();
  // sequential: two concurrent freePort() calls can hand out the same port on Windows
  go = await startSide("go", tpl);
  ts = await startSide("ts", tpl);
});
afterAll(() => {
  if (go) stopSide(go);
  if (ts) stopSide(ts);
});

async function collect(side: Side, mutate: () => Promise<void>): Promise<string[]> {
  const ctl = new AbortController();
  const res = await fetch(`${side.base}/api/events`, { signal: ctl.signal });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const events: string[] = [];
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const r = await reader?.read().catch(() => undefined);
      if (!r || r.done) return;
      buf += dec.decode(r.value);
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        // generated memory ids are random in Go too
        events.push(
          mask(buf.slice(0, idx), side).replace(
            /"memory":\{"id":"[a-z0-9]{6}"/,
            '"memory":{"id":"<MID>"',
          ),
        );
        buf = buf.slice(idx + 2);
        idx = buf.indexOf("\n\n");
      }
    }
  })();
  await Bun.sleep(300);
  await mutate();
  await Bun.sleep(1500);
  ctl.abort();
  await pump;
  return events.filter(
    (e) => !e.startsWith("event: service:status") && !e.startsWith("event: tasks:lifecycle-sweep"),
  );
}

describe.skipIf(!hasGoBin)("SSE parity with the Go server", () => {
  test("event sequence after mutations", async () => {
    const run = (side: Side) => async () => {
      const post = (p: string, b?: unknown, m = "POST") =>
        send(side, m, p, { body: b === undefined ? undefined : JSON.stringify(b), headers: J });
      await post("/api/tasks", { id: "aaaaaa", title: "One", status: "todo" });
      await post("/api/tasks", { id: "bbbbbb", title: "Two" });
      await post("/api/tasks/aaaaaa", { title: "Uno", priority: "high" }, "PUT");
      await post("/api/time/start", { taskId: "aaaaaa" });
      await post("/api/time/pause", { taskId: "aaaaaa" });
      await post("/api/time/stop", { taskId: "aaaaaa" });
      await post("/api/tasks/reorder", {
        orders: [
          { id: "aaaaaa", order: 1 },
          { id: "bbbbbb", order: 2 },
        ],
      });
      await post("/api/tasks/bbbbbb/archive", { execute: true });
      await post("/api/docs", { title: "Doc", content: "x" });
      await post("/api/docs/doc", { content: "y" }, "PUT");
      await post("/api/memories", { title: "M", content: "c", skipReview: true });
      await post("/api/templates", { name: "tpl" });
      await post("/api/notify/refresh");
      await post("/api/notify/doc/doc");
      await post("/api/notify/task/aaaaaa");
      await post("/api/notify/time");
      await post("/api/auth/password", { password: "pw" });
    };
    const [a, b] = await Promise.all([collect(go, run(go)), collect(ts, run(ts))]);
    expect(b.join("\n--\n")).toBe(a.join("\n--\n"));
    expect(a.length).toBeGreaterThan(10);
  }, 60_000);
});
