import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { newMcpApp } from "../../src/mcp/index.ts";
import type { McpLogger } from "../../src/mcp/log.ts";
import { SearchPool } from "../../src/mcp/search-pool.ts";
import { makeSandbox } from "./harness.ts";

const silent = { printf: () => undefined } as unknown as McpLogger;
const req = { name: "search", args: { action: "search", query: "x" }, id: 1 };

function scriptWorker(body: string): () => Worker {
  const file = join(mkdtempSync(join(tmpdir(), "kn-sw-")), "w.mjs");
  writeFileSync(file, body);
  return () => new Worker(file);
}

describe("SearchPool", () => {
  test("a cancelled call terminates its worker even when it spins synchronously", async () => {
    const pool = new SearchPool(1, scriptWorker("for(;;){}"));
    const ac = new AbortController();
    const run = pool.run({ storeRoot: "/s", projectRoot: "/p", req }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(run).rejects.toThrow(/cancelled/);
    expect(pool.size).toBe(0); // the dead worker is dropped
    await pool.stop();
  });

  test("the event loop keeps running while a worker spins", async () => {
    const pool = new SearchPool(1, scriptWorker("for(;;){}"));
    const ac = new AbortController();
    const run = pool
      .run({ storeRoot: "/s", projectRoot: "/p", req }, ac.signal)
      .catch(() => undefined);
    let ticks = 0;
    const t = setInterval(() => ticks++, 5);
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(t);
    expect(ticks).toBeGreaterThan(5); // a blocked loop would see none (Windows timers tick at ~15 ms)
    ac.abort();
    await run;
    await pool.stop();
  });

  test("a worker that crashes rejects the call and is replaced on the next one", async () => {
    let n = 0;
    const crash = scriptWorker("throw new Error('boom')");
    const echo = scriptWorker(
      "import {parentPort} from 'node:worker_threads'; parentPort.on('message', m => parentPort.postMessage({id: m.id, text: 'ok', isError: false}));",
    );
    const pool = new SearchPool(1, () => (n++ === 0 ? crash() : echo()));
    await expect(pool.run({ storeRoot: "/s", projectRoot: "/p", req })).rejects.toThrow();
    expect(await pool.run({ storeRoot: "/s", projectRoot: "/p", req })).toEqual({
      text: "ok",
      isError: false,
    });
    await pool.stop();
  });

  test("no more workers than the width", async () => {
    const echo = scriptWorker(
      "import {parentPort} from 'node:worker_threads'; parentPort.on('message', m => setTimeout(() => parentPort.postMessage({id: m.id, text: 'ok', isError: false}), 50));",
    );
    const pool = new SearchPool(2, echo);
    const a = pool.run({ storeRoot: "/s", projectRoot: "/p", req });
    const b = pool.run({ storeRoot: "/s", projectRoot: "/p", req });
    await expect(pool.run({ storeRoot: "/s", projectRoot: "/p", req })).rejects.toThrow(/no free/);
    await Promise.all([a, b]);
    expect(pool.size).toBe(2);
    await pool.stop();
  });
});

describe("search through a daemon-hosted session", () => {
  test("the worker answers exactly what the in-thread handler answers", async () => {
    const sb = makeSandbox("full");
    const call = async (hosted: boolean, args: Record<string, unknown>) => {
      const app = newMcpApp("", silent, { cwd: sb.dir, daemonHosted: hosted });
      await app.begin();
      try {
        const out: string[] = [];
        const lines = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "t", version: "1" },
            },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "search", arguments: args },
          },
        ];
        await app.server.serve(
          (async function* () {
            yield new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
          })(),
          (t) => out.push(t),
        );
        return JSON.parse(out.find((l) => l.includes('"id":2')) as string).result;
      } finally {
        app.cleanup("test");
      }
    };
    // Project-scoped types only: Bun 1.3 ignores an assignment to HOME inside a worker, so a
    // worker under the test's sandbox HOME would still read the real global memory store.
    for (const args of [
      { action: "search", query: "task", mode: "keyword", type: "task" },
      { action: "search", query: "knowns", mode: "keyword", type: "doc" },
      { action: "search", query: "zzzz-no-such-thing", mode: "keyword", type: "doc" },
      { action: "search" }, // missing query is an ordinary tool error
    ]) {
      expect(await call(true, args)).toEqual(await call(false, args));
    }
    const { sharedSearchPool } = await import("../../src/mcp/pool.ts");
    await (await sharedSearchPool()).stop();
  }, 60_000);
});

describe("SearchPool idle workers (KN-69EHXE P2-3)", () => {
  const reply =
    "import {parentPort} from 'node:worker_threads'; parentPort.on('message', m => parentPort.postMessage({id: m.id, text: 'ok', isError: false}));";

  test("an idle worker that crashes is dropped without an unhandled error, then replaced", async () => {
    let n = 0;
    const dying = scriptWorker(
      `${reply} parentPort.on('message', () => setTimeout(() => { throw new Error('late crash'); }, 20));`,
    );
    const echo = scriptWorker(reply);
    const pool = new SearchPool(1, () => (n++ === 0 ? dying() : echo()));
    const job = { storeRoot: "/s", projectRoot: "/p", req };
    expect((await pool.run(job)).text).toBe("ok");
    await new Promise((r) => setTimeout(r, 200)); // the idle worker dies here
    expect(pool.size).toBe(0);
    expect((await pool.run(job)).text).toBe("ok"); // a fresh worker, not a hang
    await pool.stop();
  });

  test("an idle worker that exits is dropped", async () => {
    let n = 0;
    const exiting = scriptWorker(
      `${reply} parentPort.on('message', () => setTimeout(() => process.exit(0), 20));`,
    );
    const echo = scriptWorker(reply);
    const pool = new SearchPool(1, () => (n++ === 0 ? exiting() : echo()));
    const job = { storeRoot: "/s", projectRoot: "/p", req };
    await pool.run(job);
    await new Promise((r) => setTimeout(r, 200));
    expect(pool.size).toBe(0);
    expect((await pool.run(job)).text).toBe("ok");
    await pool.stop();
  });
});
