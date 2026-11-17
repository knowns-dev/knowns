import { describe, expect, test } from "bun:test";
import { CallTimeoutError, defaultPoolWidth, ToolPool } from "../../src/mcp/pool.ts";
import { McpServer } from "../../src/mcp/server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pool width", () => {
  test("1..4 from the CPU count", () => {
    expect(defaultPoolWidth(1)).toBe(1);
    expect(defaultPoolWidth(4)).toBe(2);
    expect(defaultPoolWidth(8)).toBe(4);
    expect(defaultPoolWidth(64)).toBe(4);
  });
});

describe("ToolPool", () => {
  test("heavy calls never run more than width at once; light calls bypass the gate", async () => {
    const pool = new ToolPool(2, 5000);
    let now = 0;
    let peak = 0;
    const heavy = () =>
      pool.run("code", async () => {
        peak = Math.max(peak, ++now);
        await sleep(80);
        now--;
      });
    const all = Promise.all([heavy(), heavy(), heavy(), heavy(), heavy()]);
    await sleep(20);
    const t = Date.now();
    await pool.run("tasks", async () => "light");
    expect(Date.now() - t).toBeLessThan(40); // not queued behind the saturated gate
    await all;
    expect(peak).toBe(2);
  });

  test("a deadline errors only that call and aborts its signal", async () => {
    // The other call must finish well inside the deadline even when a CI runner stalls for a
    // while: 30 ms of work against a 250 ms deadline (it was 100 ms, and a macOS runner pause
    // made the healthy call time out too).
    const pool = new ToolPool(2, 250);
    let aborted = false;
    const slow = pool.run("code", (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return sleep(1000);
    });
    const other = pool.run("code", async () => {
      await sleep(30);
      return "fine";
    });
    await expect(slow).rejects.toBeInstanceOf(CallTimeoutError);
    expect(await other).toBe("fine");
    expect(aborted).toBe(true);
  });

  test("a deadline, or a handler that fails after it, never raises an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pool = new ToolPool(2, 15, 10);
      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < 40; i++) {
        // light and heavy; some handlers ignore the signal and fail after the deadline, some
        // wait for a slot behind a stuck one and are cancelled while queued
        const tool = i % 2 === 0 ? "code" : "tasks";
        calls.push(
          pool
            .run(tool, async () => {
              await sleep(40);
              if (i % 3 === 0) throw new Error("late failure");
            })
            .catch(() => undefined),
        );
      }
      await Promise.all(calls);
      await sleep(150); // late failures and grace timers land
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a slot stays held until the handler settles, even after its deadline", async () => {
    const pool = new ToolPool(1, 50);
    const stuck = pool.run("code", () => sleep(300)).catch(() => undefined);
    await sleep(80); // deadline passed, handler still running
    expect(pool.running).toBe(1);
    await stuck;
    await sleep(300);
    expect(pool.running).toBe(0);
  });

  test("a call that times out while queued leaves the queue without running", async () => {
    const pool = new ToolPool(1, 80);
    const hold = pool.run("code", () => sleep(250)).catch(() => undefined);
    let ran = false;
    const queued = pool.run("code", async () => {
      ran = true;
    });
    await expect(queued).rejects.toBeInstanceOf(CallTimeoutError);
    await hold;
    await sleep(300);
    expect(ran).toBe(false);
    expect(pool.queued).toBe(0);
  });

  test("an aborted session leaves the queue", async () => {
    const pool = new ToolPool(1, 5000);
    const hold = pool.run("code", () => sleep(150));
    const ac = new AbortController();
    const queued = pool.run("code", async () => "x", ac.signal);
    ac.abort();
    await expect(queued).rejects.toThrow(/cancelled/);
    await hold;
    expect(pool.queued).toBe(0);
  });
});

type Reply = { id: number; result: { isError?: boolean; content: { text: string }[] } };

describe("McpServer with a pool", () => {
  function serverWith(pool: ToolPool): McpServer {
    const server = new McpServer({ name: "t", version: "0", instructions: "", pool });
    const tool = (name: string) =>
      ({ name, description: "", properties: {}, required: [], annotations: {} }) as never;
    server.addTool(tool("code"), async (ctx) => {
      await sleep(400);
      return { text: ctx.signal?.aborted ? "aborted" : "done", isError: false } as never;
    });
    server.addTool(tool("tasks"), async () => ({ text: "ok", isError: false }) as never);
    return server;
  }

  async function exchange(server: McpServer, lines: object[], waitMs: number): Promise<Reply[]> {
    const out: Reply[] = [];
    const input = (async function* () {
      yield new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      await sleep(waitMs);
    })();
    await server.serve(input, (t) => out.push(JSON.parse(t)));
    return out;
  }
  const call = (id: number, name: string) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  });

  test("a timed-out call answers its own session with an error result", async () => {
    const out = await exchange(serverWith(new ToolPool(2, 100)), [call(1, "code")], 300);
    const r = out[0] as Reply;
    expect(r.id).toBe(1);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("timed out");
  });

  test("a timeout in one session leaves another session on the same pool working", async () => {
    const pool = new ToolPool(2, 100);
    const [a, b] = await Promise.all([
      exchange(serverWith(pool), [call(1, "code")], 300),
      exchange(serverWith(pool), [call(2, "tasks"), call(3, "tasks")], 100),
    ]);
    expect(a[0]?.result.isError).toBe(true);
    expect(b.map((r) => r.result.content[0]?.text)).toEqual(["ok", "ok"]);
  });

  test("light calls stay fast while every heavy slot is busy (AC-1 shape)", async () => {
    const pool = new ToolPool(2, 5000);
    const heavy = [1, 2, 3, 4].map((i) => exchange(serverWith(pool), [call(i, "code")], 500));
    await sleep(50);
    const lat: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await exchange(serverWith(pool), [call(100 + i, "tasks")], 0);
      lat.push(performance.now() - t);
    }
    lat.sort((x, y) => x - y);
    expect(lat[Math.floor(lat.length * 0.95)]).toBeLessThan(150);
    await Promise.all(heavy);
  });
});

describe("ToolPool review fixes (KN-69EHXE)", () => {
  test("P2-5: a timed-out light tool says the operation may still complete", async () => {
    const pool = new ToolPool(1, 40);
    const err = (await pool.run("tasks", () => sleep(150)).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CallTimeoutError);
    expect(String(err.message)).toContain("may still complete");
    const heavy = (await pool.run("search", () => sleep(150)).catch((e) => e)) as Error;
    expect(String(heavy.message)).not.toContain("may still complete");
  });

  test("P2-6: a hung heavy call gives its slot up after the grace, and the cap fires the hook", async () => {
    let capped = 0;
    const pool = new ToolPool(1, 30, 40, () => {
      capped++;
    });
    const never = new Promise<void>(() => {});
    const hung = pool.run("code", () => never).catch(() => undefined);
    await hung; // deadline error
    expect(pool.running).toBe(1);
    await sleep(80); // grace passed
    expect(pool.running).toBe(0);
    expect(pool.leakedSlots).toBe(1);
    // The slot is usable again.
    expect(await pool.run("code", async () => "ok")).toBe("ok");
    // A second hung call reaches the cap (LEAK_CAP = 2).
    await pool.run("code", () => never).catch(() => undefined);
    await sleep(80);
    expect(pool.leakedSlots).toBe(2);
    expect(capped).toBe(1);
  });

  test("P2-6: a handler that settles after its slot was given up repays the leak", async () => {
    const pool = new ToolPool(1, 20, 30);
    await pool.run("code", () => sleep(120)).catch(() => undefined);
    await sleep(50);
    expect(pool.leakedSlots).toBe(1);
    await sleep(120);
    expect(pool.leakedSlots).toBe(0);
    expect(pool.running).toBe(0);
  });
});
