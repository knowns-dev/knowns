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
    const pool = new ToolPool(2, 100);
    let aborted = false;
    const slow = pool.run("code", (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return sleep(400);
    });
    const other = pool.run("code", async () => {
      await sleep(30);
      return "fine";
    });
    await expect(slow).rejects.toBeInstanceOf(CallTimeoutError);
    expect(await other).toBe("fine");
    expect(aborted).toBe(true);
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

  async function exchange(server: McpServer, lines: object[], waitMs: number): Promise<any[]> {
    const out: any[] = [];
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
    expect(out[0].id).toBe(1);
    expect(out[0].result.isError).toBe(true);
    expect(out[0].result.content[0].text).toContain("timed out");
  });

  test("a timeout in one session leaves another session on the same pool working", async () => {
    const pool = new ToolPool(2, 100);
    const [a, b] = await Promise.all([
      exchange(serverWith(pool), [call(1, "code")], 300),
      exchange(serverWith(pool), [call(2, "tasks"), call(3, "tasks")], 100),
    ]);
    expect(a[0].result.isError).toBe(true);
    expect(b.map((r) => r.result.content[0].text)).toEqual(["ok", "ok"]);
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
    expect(lat[Math.floor(lat.length * 0.95)]).toBeLessThan(50);
    await Promise.all(heavy);
  });
});
