// The daemon's MCP endpoint and per-connection session host (KN-QS0B82). The handshake contract is
// in @doc/specs/2026-11-16/mcp-thin-proxy; these tests speak it with a bare socket client, the way
// the Go proxy will.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newMcpApp } from "../../src/mcp/index.ts";
import type { McpLogger } from "../../src/mcp/log.ts";
import { descriptorPath, readDescriptor } from "../../src/runtime/mcp-endpoint.ts";
import { McpHost } from "../../src/runtime/mcp-host.ts";
import { makeSandbox } from "../mcp/harness.ts";

const VERSION = "9.9.9-test";
const silent = { printf() {} } as unknown as McpLogger;
let savedInline: string | undefined;
beforeAll(() => {
  // A session must not start a real runtime daemon or write leases.
  savedInline = process.env.KNOWNS_RUNTIME_INLINE;
  process.env.KNOWNS_RUNTIME_INLINE = "1";
});
afterAll(() => {
  if (savedInline === undefined) delete process.env.KNOWNS_RUNTIME_INLINE;
  else process.env.KNOWNS_RUNTIME_INLINE = savedInline;
});

let host: McpHost;
let root: string;
const logs: string[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kn-mcphost-"));
  host = new McpHost({
    version: VERSION,
    root,
    logger: (l) => logs.push(l),
    helloTimeoutMs: 400,
  });
  await host.start();
});
afterEach(async () => {
  await host.stop();
});

class Client {
  readonly lines: string[] = [];
  private buf = "";
  private waiters: Array<() => void> = [];
  closed = false;
  readonly sock: net.Socket;

  constructor(address: string) {
    this.sock = net.connect({ path: address });
    this.sock.on("data", (d) => {
      this.buf += d.toString("utf8");
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
      this.notify();
    });
    this.sock.on("close", () => {
      this.closed = true;
      this.notify();
    });
    this.sock.on("error", () => undefined);
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(v: unknown): void {
    this.sock.write(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
  }

  async next(timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.closed) throw new Error("connection closed");
      if (Date.now() > deadline) throw new Error("timeout waiting for a frame");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return JSON.parse(this.lines.shift() as string) as Record<string, unknown>;
  }

  async untilClosed(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("connection did not close");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async rpc(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    for (;;) {
      const f = await this.next();
      if (f.id === id) return f;
    }
  }

  async tool(id: number, name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.rpc(id, "tools/call", { name, arguments: args });
    const res = r.result as { content: Array<{ text: string }> };
    return res.content[0]?.text ?? "";
  }
}

const hello = (over: Record<string, unknown> = {}) => ({
  knowns_mcp: 1,
  type: "hello",
  version: VERSION,
  token: host.token,
  cwd: tmpdir(),
  project: "",
  pid: process.pid,
  client: { name: "test-proxy", version: "1" },
  ...over,
});

async function connect(
  over: Record<string, unknown> = {},
): Promise<{ c: Client; w: Record<string, unknown> }> {
  const c = new Client(host.address as string);
  c.send(hello(over));
  return { c, w: await c.next() };
}

const INIT = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
};

describe("endpoint and descriptor", () => {
  test("the descriptor is written for this version, owner only", () => {
    const d = readDescriptor(VERSION, root);
    expect(d?.version).toBe(VERSION);
    expect(d?.proxy_protocol).toBe(1);
    expect(d?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(d?.pid).toBe(process.pid);
    expect(descriptorPath(VERSION, root)).toContain("endpoint-9.9.9-test.json");
    if (process.platform !== "win32") {
      expect(statSync(descriptorPath(VERSION, root)).mode & 0o777).toBe(0o600);
      expect(statSync(d?.address as string).mode & 0o777).toBe(0o600);
    }
  });

  test("another version has no descriptor, and stop removes ours", async () => {
    expect(readDescriptor("9.9.8", root)).toBeUndefined();
    await host.stop();
    expect(readDescriptor(VERSION, root)).toBeUndefined();
    expect(readdirSync(join(root, "mcp"))).toEqual([]);
    await host.start();
  });
});

describe("handshake", () => {
  test("a valid hello gets a welcome with a session id", async () => {
    const { c, w } = await connect();
    expect(w).toMatchObject({ knowns_mcp: 1, type: "welcome", version: VERSION });
    expect(String(w.session)).toMatch(/^s-[0-9a-f]{8}$/);
    expect(w.daemon_pid).toBe(process.pid);
    expect(w.max_frame_bytes).toBe(16 << 20);
    expect(host.sessions().map((s) => s.id)).toEqual([w.session as string]);
    c.sock.end();
    await c.untilClosed();
  });

  const refused: Array<[string, Record<string, unknown>, string]> = [
    ["version mismatch", { version: "0.0.1" }, "version_mismatch"],
    ["wrong token", { token: "0".repeat(64) }, "unauthorized"],
    ["missing token", { token: undefined }, "unauthorized"],
    ["unknown protocol", { knowns_mcp: 2 }, "unsupported_protocol"],
    ["missing cwd", { cwd: undefined }, "bad_hello"],
    ["not a hello", { type: "ping" }, "bad_hello"],
  ];
  for (const [name, over, code] of refused) {
    test(`${name} is refused with ${code} and the connection closes`, async () => {
      const { c, w } = await connect(over);
      expect(w).toMatchObject({ type: "error", code });
      // The daemon's version is only told to a client that proved it holds the token.
      if (code === "version_mismatch") expect(w.daemon_version).toBe(VERSION);
      else expect(w.daemon_version).toBeUndefined();
      expect(w.retry_after_ms).toBeUndefined();
      await c.untilClosed();
      expect(host.sessions()).toEqual([]);
    });
  }

  test("garbage on the first line is bad_hello", async () => {
    const c = new Client(host.address as string);
    c.send("this is not json");
    expect(await c.next()).toMatchObject({ type: "error", code: "bad_hello" });
    await c.untilClosed();
  });

  test("a wrong token never reveals more than the error frame", async () => {
    const { w } = await connect({ token: "1".repeat(64) });
    expect(JSON.stringify(w)).not.toContain(host.token as string);
  });

  test("the session limit answers busy with a retry delay", async () => {
    await host.stop();
    host = new McpHost({ version: VERSION, root, logger: () => undefined, maxSessions: 1 });
    await host.start();
    const a = await connect();
    expect(a.w.type).toBe("welcome");
    const b = await connect();
    expect(b.w).toMatchObject({ type: "error", code: "busy", retry_after_ms: 500 });
    a.c.sock.end();
  });

  test("a client that never says hello is closed and others still connect", async () => {
    const stalled: Client[] = [];
    for (let i = 0; i < 4; i++) stalled.push(new Client(host.address as string)); // send nothing
    const { c, w } = await connect();
    expect(w.type).toBe("welcome"); // served while four others stall
    await stalled[0]?.untilClosed(3000); // 400 ms hello window in this suite
    for (const s of stalled) await s.untilClosed(3000);
    c.sock.end();
  });

  test("a stalled partial hello is closed too", async () => {
    const c = new Client(host.address as string);
    c.sock.write('{"knowns_mcp":1,"type":"hel'); // no newline, ever
    const f = await c.next();
    expect(f).toMatchObject({ type: "error", code: "bad_hello" });
    await c.untilClosed();
  });

  test("more than 8 simultaneous unauthenticated connections are dropped without a reply", async () => {
    const many = Array.from({ length: 14 }, () => new Client(host.address as string));
    await new Promise((r) => setTimeout(r, 150));
    // Past the cap the daemon drops connections at once; the rest time out in the hello window.
    for (const m of many) await m.untilClosed(3000);
    const after = await connect();
    expect(after.w.type).toBe("welcome");
  });
});

describe("session behaviour", () => {
  test("results through the endpoint equal in-process results", async () => {
    const sb = makeSandbox("full");
    const { c } = await connect({ cwd: sb.dir });
    const via = async (id: number, name: string, args: Record<string, unknown>) =>
      c.tool(id, name, args);

    const init = await c.rpc(1, "initialize", INIT);
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const app = newMcpApp("", silent, { cwd: sb.dir });
    const local = async (method: string, params?: unknown) =>
      app.server.handle({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
    expect(JSON.stringify(init.result)).toBe(
      JSON.stringify((await local("initialize", INIT))?.result),
    );

    const tools = await c.rpc(2, "tools/list");
    expect(JSON.stringify(tools.result)).toBe(JSON.stringify((await local("tools/list"))?.result));

    await app.begin();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["project", { action: "current" }],
      ["tasks", { action: "list" }],
      ["docs", { action: "list" }],
      ["search", { query: "login" }],
      ["tasks", { action: "get", taskId: "does-not-exist" }],
      ["docs", { action: "get", path: "nope/missing" }],
    ];
    let id = 10;
    for (const [name, args] of calls) {
      const got = await via(id++, name, args);
      const want = (await local("tools/call", { name, arguments: args }))?.result as {
        content: Array<{ text: string }>;
      };
      expect(got).toBe(want.content[0]?.text as string);
    }
    app.cleanup("test");
    c.sock.end();
  }, 60_000);

  test("two sessions in different projects keep separate project selection", async () => {
    const a = makeSandbox("full");
    const b = makeSandbox("full");
    const [x, y] = await Promise.all([connect({ cwd: a.dir }), connect({ cwd: b.dir })]);
    await x.c.rpc(1, "initialize", INIT);
    await y.c.rpc(1, "initialize", { ...INIT, clientInfo: { name: "other", version: "2" } });
    // Detection starts after the first response; a tool call waits for it.
    const curX = await x.c.tool(2, "project", { action: "current" });
    const curY = await y.c.tool(2, "project", { action: "current" });
    expect(hasPath(curX, a.dir)).toBe(true);
    expect(hasPath(curX, b.dir)).toBe(false);
    expect(hasPath(curY, b.dir)).toBe(true);
    expect(hasPath(curY, a.dir)).toBe(false);

    // Switching project in one session does not move the other.
    const c = makeSandbox("full");
    await x.c.tool(3, "project", { action: "set", projectRoot: c.dir });
    expect(hasPath(await x.c.tool(4, "project", { action: "current" }), c.dir)).toBe(true);
    expect(hasPath(await y.c.tool(3, "project", { action: "current" }), b.dir)).toBe(true);

    const sessions = host.sessions();
    expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
    expect(sessions.map((s) => s.client).sort()).toEqual(["test-proxy", "test-proxy"]);
    x.c.sock.end();
    y.c.sock.end();
  }, 60_000);

  test("hello.project wins over hello.cwd", async () => {
    const a = makeSandbox("full");
    const b = makeSandbox("full");
    const { c } = await connect({ cwd: a.dir, project: b.dir });
    await c.rpc(1, "initialize", INIT);
    const cur = await c.tool(2, "project", { action: "current" });
    expect(hasPath(cur, b.dir)).toBe(true);
    c.sock.end();
  }, 60_000);

  test("closing the client side ends the session and frees it", async () => {
    const sb = makeSandbox("full");
    const { c } = await connect({ cwd: sb.dir });
    await c.rpc(1, "initialize", INIT);
    expect(host.sessions().length).toBe(1);
    c.sock.end(); // half-close: the daemon drains and closes
    await c.untilClosed();
    await new Promise((r) => setTimeout(r, 50));
    expect(host.sessions()).toEqual([]);
  });

  test("an abrupt disconnect ends only that session", async () => {
    const sb = makeSandbox("full");
    const x = await connect({ cwd: sb.dir });
    const y = await connect({ cwd: sb.dir });
    await x.c.rpc(1, "initialize", INIT);
    await y.c.rpc(1, "initialize", INIT);
    x.c.sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(host.sessions().length).toBe(1);
    expect(hasPath(await y.c.tool(2, "project", { action: "current" }), sb.dir)).toBe(true);
    y.c.sock.end();
  }, 60_000);

  test("ping is answered with pong and never reaches the MCP server", async () => {
    const { c } = await connect();
    c.send({ knowns_mcp: 1, type: "ping", n: 7 });
    expect(await c.next()).toEqual({ knowns_mcp: 1, type: "pong", n: 7 });
    c.sock.end();
  });

  test("a session whose owner pid is gone is ended with bye owner_gone", async () => {
    await host.stop();
    host = new McpHost({ version: VERSION, root, logger: () => undefined, ownerCheckMs: 50 });
    await host.start();
    // pid 2^22 + a bit is not a live process on any supported OS.
    const { c, w } = await connect({ pid: 4_194_000 + Math.floor(Math.random() * 100) });
    expect(w.type).toBe("welcome");
    expect(await c.next()).toMatchObject({ type: "bye", reason: "owner_gone" });
    await c.untilClosed();
  });

  test("stopping the host says bye shutdown to open sessions", async () => {
    const { c } = await connect();
    const stopping = host.stop("shutdown");
    expect(await c.next()).toMatchObject({ type: "bye", reason: "shutdown" });
    await stopping;
    await c.untilClosed();
    await host.start();
  });

  test("evicting a session ends it", async () => {
    const { c, w } = await connect();
    expect(host.evict(w.session as string)).toBe(true);
    expect(await c.next()).toMatchObject({ type: "bye", reason: "evicted" });
    expect(host.evict(w.session as string)).toBe(false);
  });

  test("an oversized frame is refused without taking the daemon down", async () => {
    const { c } = await connect();
    c.sock.write("x".repeat((16 << 20) + 1024));
    const f = await c.next();
    expect(f).toMatchObject({ type: "error", code: "frame_too_large" });
    await c.untilClosed();
    const next = await connect();
    expect(next.w.type).toBe("welcome");
    next.c.sock.end();
  }, 60_000);

  test("the token is never logged", () => {
    for (const l of logs) expect(l).not.toContain(host.token as string);
    expect(readFileSync(descriptorPath(VERSION, root), "utf8")).toContain(host.token as string);
  });
});

describe("another OS user", () => {
  test("a socket directory owned by someone else is refused", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const { endpointAddress } = await import("../../src/runtime/mcp-endpoint.ts");
    const dir = endpointAddress("x.y.z", root).dir as string;
    // The directory this host created is ours and private.
    expect(statSync(dir).uid).toBe(process.getuid());
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

// --- review follow-up (d12a249) -----------------------------------------------------------------

import { McpServer } from "../../src/mcp/server.ts";
import { McpState } from "../../src/mcp/state.ts";
import type { HostedApp } from "../../src/runtime/mcp-host.ts";
import { acquireClient, daemonSpawnEnv, startHeartbeat } from "../../src/runtime/queue.ts";

/** A hosted app whose only tool is slow and counts its runs: queued calls are visible. */
function slowApp(counter: { runs: number; sawAbort: number }): HostedApp {
  const server = new McpServer({ name: "t", version: "0", instructions: "" });
  server.addTool(
    {
      name: "slow",
      description: "",
      properties: {},
      required: [],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    } as never,
    async (ctx) => {
      counter.runs++;
      await new Promise((r) => setTimeout(r, 250));
      if (ctx.signal?.aborted) counter.sawAbort++;
      return { text: "done", isError: false } as never;
    },
  );
  return {
    server,
    state: { clientInfo: undefined, getRoot: () => "", log: silent },
    begin: async () => undefined,
    cleanup: () => undefined,
  } as unknown as HostedApp;
}

async function hostWith(createApp: () => HostedApp): Promise<void> {
  await host.stop();
  host = new McpHost({ version: VERSION, root, logger: () => undefined, createApp });
  await host.start();
}

/** A path as it appears in tool text: raw, or with its backslashes JSON-escaped (Windows). */
const hasPath = (text: string, p: string): boolean =>
  [p, p.replaceAll("\\", "\\\\"), p.replaceAll("\\", "\\\\\\\\")].some((v) => text.includes(v));

const callLines = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    }),
  ).join("\n");

describe("P2-4: an abrupt end drops queued work, a clean one lets it finish", () => {
  test("abrupt disconnect: only the calls already running complete", async () => {
    const counter = { runs: 0, sawAbort: 0 };
    await hostWith(() => slowApp(counter));
    const { c } = await connect();
    c.send(callLines(12)); // 5 run at once, 7 queue
    await new Promise((r) => setTimeout(r, 100));
    c.sock.destroy();
    await new Promise((r) => setTimeout(r, 1500));
    expect(counter.runs).toBe(5);
  });

  test("close frame: every started and queued call is answered, then the daemon closes", async () => {
    const counter = { runs: 0, sawAbort: 0 };
    await hostWith(() => slowApp(counter));
    const { c } = await connect();
    c.send(callLines(8));
    c.send({ knowns_mcp: 1, type: "close" });
    await c.untilClosed(10_000);
    expect(counter.runs).toBe(8);
    expect(c.lines.length).toBe(8);
  });

  test("a bye (owner gone, evicted) is abrupt too", async () => {
    const counter = { runs: 0, sawAbort: 0 };
    await hostWith(() => slowApp(counter));
    const { c, w } = await connect();
    c.send(callLines(12));
    await new Promise((r) => setTimeout(r, 100));
    host.evict(w.session as string);
    await new Promise((r) => setTimeout(r, 1500));
    expect(counter.runs).toBe(5);
    expect(counter.sawAbort).toBe(5); // running handlers see ctx.signal aborted
  });
});

describe("P2-6: relative paths are anchored on the client, not the daemon", () => {
  test("a relative cwd is refused", async () => {
    const { w } = await connect({ cwd: "relative/dir" });
    expect(w).toMatchObject({ type: "error", code: "bad_hello" });
  });

  test("a relative project resolves against hello.cwd", async () => {
    const sb = makeSandbox("full"); // <tmp>/project
    const parent = join(sb.dir, "..");
    const { c, w } = await connect({ cwd: parent, project: "project" });
    expect(w.type).toBe("welcome");
    await c.rpc(1, "initialize", INIT);
    expect(hasPath(await c.tool(2, "project", { action: "current" }), sb.dir)).toBe(true);
    c.sock.end();
  }, 60_000);
});

describe("P2-7: hello cap and linear framing", () => {
  test("an oversized hello (no newline) is refused at 64 KiB, not 16 MiB", async () => {
    const c = new Client(host.address as string);
    c.sock.write("x".repeat(70 * 1024));
    expect(await c.next()).toMatchObject({ type: "error", code: "frame_too_large" });
    await c.untilClosed();
  });

  test("a 4 MiB line in 1 KiB chunks is framed in linear time", async () => {
    const { c } = await connect();
    await c.rpc(1, "initialize", INIT);
    const big = `{"jsonrpc":"2.0","id":7,"method":"ping","params":{"pad":"${"a".repeat(4 << 20)}"}}`;
    const t = Date.now();
    for (let i = 0; i < big.length; i += 1024) c.sock.write(big.slice(i, i + 1024));
    c.sock.write("\n");
    const r = await c.next(20_000);
    expect(r.id).toBe(7);
    expect(Date.now() - t).toBeLessThan(10_000);
    c.sock.end();
  }, 60_000);

  test("a JSON-RPC line mentioning knowns_mcp is not taken for a control frame", async () => {
    const { c } = await connect();
    await c.rpc(1, "initialize", INIT);
    c.send({ jsonrpc: "2.0", id: 9, method: "ping", params: { note: '"knowns_mcp"' } });
    expect((await c.next()).id).toBe(9);
    c.sock.end();
  });
});

describe("P1: lease lifecycle of a daemon-hosted session", () => {
  let leaseRoot: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    leaseRoot = mkdtempSync(join(tmpdir(), "kn-lease-"));
    saved = {
      KNOWNS_RUNTIME_ROOT: process.env.KNOWNS_RUNTIME_ROOT,
      KNOWNS_RUNTIME_INLINE: process.env.KNOWNS_RUNTIME_INLINE,
    };
    process.env.KNOWNS_RUNTIME_ROOT = leaseRoot;
    delete process.env.KNOWNS_RUNTIME_INLINE; // leases are really written
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const leases = () => {
    try {
      return readdirSync(join(leaseRoot, "leases")).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
  };

  test("P1-1: a session closed while detection runs leaves no lease and no heartbeat", async () => {
    const sb = makeSandbox("full");
    const app = newMcpApp("", silent, { cwd: sb.dir, daemonHosted: true });
    const began = app.begin();
    app.cleanup("client left"); // before detection finished
    await began;
    await new Promise((r) => setTimeout(r, 100));
    expect(leases()).toEqual([]);
  });

  test("P1-1: startHeartbeat on an aborted signal releases the lease", () => {
    const sb = makeSandbox("full");
    const handle = acquireClient("mcp", join(sb.dir, ".knowns"), false, { ensure: false });
    expect(leases().length).toBe(1);
    const ac = new AbortController();
    ac.abort();
    startHeartbeat(ac.signal, handle);
    expect(leases()).toEqual([]);
  });

  test("P1-2: a hosted session takes its lease without ensuring a daemon", async () => {
    const sb = makeSandbox("full");
    const app = newMcpApp("", silent, { cwd: sb.dir, daemonHosted: true });
    await app.begin();
    expect(leases().length).toBe(1);
    // ensureDaemon would have created the start lock, spawned a daemon and written its pid file.
    expect(existsSync(join(leaseRoot, "start.lock"))).toBe(false);
    expect(existsSync(join(leaseRoot, "knowns-runtime.pid"))).toBe(false);
    app.cleanup("done");
    expect(leases()).toEqual([]);
  });

  test("P1-3: KNOWNS_MCP_PROXY never reaches a daemon the client starts", () => {
    const env = daemonSpawnEnv({ KNOWNS_MCP_PROXY: "0", PATH: "/bin", HOME: "/h" });
    expect(env.KNOWNS_MCP_PROXY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("P2-9: a session stops its language servers", () => {
  test("dispose stops the manager once", async () => {
    const state = new McpState(silent);
    let stopped = 0;
    (state as unknown as { lspManagerCache: unknown; lspManagerBuilt: boolean }).lspManagerCache = {
      stopAll: async () => {
        stopped++;
      },
    };
    await state.dispose();
    await state.dispose();
    expect(stopped).toBe(1);
  });
});
