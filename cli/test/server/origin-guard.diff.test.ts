// Approved divergence (D12, TSR-X86JV4): the web server accepts only its own origin. 0.34.1 trusted
// every loopback origin on any port, so a page served by another local process (a dev server, an
// app on localhost:5173) could read and write the knowledge base, which needs no auth without a
// password. Real Go and TS server processes: requests from the server's own origin and requests
// with no Origin (curl, the CLI) behave the same on both; a cross-port origin gets through Go and
// is refused by TS for reads, writes, the SSE stream and the CORS preflight.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { hasGoBin, type Side, seedTemplate, startSide, stopSide } from "./harness.ts";

setDefaultTimeout(120_000);
let go: Side;
let ts: Side;

beforeAll(async () => {
  if (!hasGoBin) return;
  const tpl = seedTemplate();
  go = await startSide("go", tpl);
  ts = await startSide("ts", tpl);
});
afterAll(() => {
  if (go) stopSide(go);
  if (ts) stopSide(ts);
});

const base = (s: Side) => `http://localhost:${s.port}`;

async function status(
  s: Side,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`${base(s)}${path}`, { method, headers, body, signal: ac.signal });
    // SSE never ends on its own: the status is all that matters.
    ac.abort();
    return res.status;
  } catch (e) {
    if ((e as Error).name === "AbortError") return -1;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const J = { "Content-Type": "application/json" };
const CASES: [string, string, string, string | undefined, Record<string, string>][] = [
  ["read", "GET", "/api/tasks", undefined, {}],
  ["write", "POST", "/api/tasks", JSON.stringify({ title: "From a page" }), J],
  ["sse", "GET", "/api/events", undefined, { Accept: "text/event-stream" }],
  [
    "preflight",
    "OPTIONS",
    "/api/tasks",
    undefined,
    { "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
  ],
];

describe.skipIf(!hasGoBin)("the web server's origin guard", () => {
  for (const [label, method, path, body, headers] of CASES) {
    test(`${label}: own origin and no origin behave as 0.34.1`, async () => {
      for (const origin of ["own", "none"]) {
        const h = (s: Side) => ({ ...headers, ...(origin === "own" ? { Origin: base(s) } : {}) });
        const g = await status(go, method, path, h(go), body);
        const t = await status(ts, method, path, h(ts), body);
        expect({ origin, status: t }).toEqual({ origin, status: g });
        expect(t).not.toBe(403);
      }
    });

    test(`${label}: another localhost port is refused (0.34.1 let it through)`, async () => {
      const evil = { ...headers, Origin: "http://localhost:5173" };
      expect(await status(go, method, path, evil, body)).not.toBe(403);
      expect(await status(ts, method, path, evil, body)).toBe(403);
    });
  }
});

describe.skipIf(!hasGoBin)("KNOWNS_ALLOWED_ORIGINS", () => {
  test("an exact allowed origin gets through, another port still does not", async () => {
    const tpl = seedTemplate();
    const dev = await startSide("ts", tpl, {
      env: { KNOWNS_ALLOWED_ORIGINS: "http://localhost:5173" },
    });
    try {
      expect(await status(dev, "GET", "/api/tasks", { Origin: "http://localhost:5173" })).toBe(200);
      expect(await status(dev, "GET", "/api/tasks", { Origin: "http://localhost:5174" })).toBe(403);
    } finally {
      stopSide(dev);
    }
  });
});
