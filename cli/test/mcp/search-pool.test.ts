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
      "import {parentPort} from 'node:worker_threads'; parentPort.on('message', m => setTimeout(() => parentPort.postMessage({id: m.id, text: 'ok', isError: false}), 400));",
    );
    const pool = new SearchPool(2, echo, { growAfterMs: 20 });
    const a = pool.run({ storeRoot: "/s", projectRoot: "/p", req });
    const b = pool.run({ storeRoot: "/s", projectRoot: "/p", req });
    await expect(pool.run({ storeRoot: "/s", projectRoot: "/p", req })).rejects.toThrow(/no free/);
    await Promise.all([a, b]);
    expect(pool.size).toBe(2);
    await pool.stop();
  });
});

const slowEcho = (ms: number) =>
  scriptWorker(
    `import {parentPort} from 'node:worker_threads'; parentPort.on('message', m => setTimeout(() => parentPort.postMessage({id: m.id, text: 'ok', isError: false}), ${ms}));`,
  );
const job = { storeRoot: "/s", projectRoot: "/p", req };

describe("SearchPool grows and shrinks with demand", () => {
  test("no worker exists until the first search", async () => {
    const pool = new SearchPool(4, slowEcho(10));
    expect(pool.size).toBe(0);
    await pool.run(job);
    expect(pool.size).toBe(1);
    await pool.stop();
  });

  test("a second call that is served quickly by the one worker does not start another", async () => {
    const pool = new SearchPool(4, slowEcho(30), { growAfterMs: 500 });
    await Promise.all([pool.run(job), pool.run(job), pool.run(job)]);
    expect(pool.size).toBe(1);
    await pool.stop();
  });

  test("a call that waits longer than the grow delay starts another worker, up to the width", async () => {
    const pool = new SearchPool(2, slowEcho(500), { growAfterMs: 50 });
    const calls = [pool.run(job), pool.run(job)];
    await Bun.sleep(200);
    expect(pool.size).toBe(2);
    await Promise.all(calls);
    await pool.stop();
  });

  test("an idle worker is ended, and the next call starts a fresh one", async () => {
    let spawned = 0;
    const make = slowEcho(10);
    const pool = new SearchPool(
      2,
      () => {
        spawned++;
        return make();
      },
      { idleMs: 120 },
    );
    await pool.run(job);
    expect(pool.size).toBe(1);
    await Bun.sleep(400);
    expect(pool.size).toBe(0);
    expect((await pool.run(job)).text).toBe("ok");
    expect(spawned).toBe(2);
    expect(pool.size).toBe(1);
    await pool.stop();
  });

  test("a call arriving as the idle timer fires is answered, not lost", async () => {
    const pool = new SearchPool(1, slowEcho(5), { idleMs: 60 });
    for (let i = 0; i < 12; i++) {
      await pool.run(job);
      await Bun.sleep(55 + (i % 4) * 4); // straddles the 60 ms expiry
    }
    await pool.run(job);
    await pool.stop();
  });

  test("a waiting call that is aborted leaves the queue, and stop rejects the rest", async () => {
    const pool = new SearchPool(2, slowEcho(300), { growAfterMs: 5000 });
    const first = pool.run(job);
    const ac = new AbortController();
    const waiting = pool.run(job, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    const stuck = pool.run(job);
    const stopping = pool.stop();
    await expect(stuck).rejects.toThrow(/stopped/);
    await first.catch(() => undefined);
    await stopping;
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

describe("worker threads never outlive their owner", () => {
  test("stopSharedSearchPool ends the search workers, and the registry shows none left", async () => {
    const { liveBundledWorkers } = await import("../../src/util/worker.ts");
    const { sharedSearchPool, stopSharedSearchPool } = await import("../../src/mcp/pool.ts");
    const pool = await sharedSearchPool();
    // A real bundled worker: the registry sees it while it runs.
    await pool
      .run({
        storeRoot: "/nonexistent",
        projectRoot: "/nonexistent",
        req,
      })
      .catch(() => undefined);
    expect(liveBundledWorkers().length).toBeGreaterThan(0);
    await stopSharedSearchPool();
    const end = Date.now() + 3000;
    while (liveBundledWorkers().length > 0 && Date.now() < end) await Bun.sleep(25);
    expect(liveBundledWorkers()).toEqual([]);
    // Stopping again is harmless, and a later call starts a fresh pool.
    await stopSharedSearchPool();
    const again = await sharedSearchPool();
    expect(again.isStopped).toBe(false);
    await stopSharedSearchPool();
  }, 30_000);
});
