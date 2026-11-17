// KN-B3NWK3: the daemon's UI host. The control connection is the listener's lease.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UiDescriptor, UiHost } from "../../src/runtime/ui-host.ts";
import { VERSION } from "../../src/version.ts";

const root = mkdtempSync(join(tmpdir(), "knowns-ui-host-"));
let host: UiHost;
let desc: UiDescriptor;
const served: { stopped: number } = { stopped: 0 };

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  host = new UiHost({
    root,
    logger: () => undefined,
    // A stub in place of the web server: a Bun listener that answers /api/config.
    serve: async (_req, bind) => {
      const bound = await bind(async () => new Response('{"ok":true}'));
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      return {
        port: bound.port,
        done,
        stop: () => {
          bound.bun.stop(true);
          served.stopped++;
          resolveDone();
        },
      };
    },
  });
  desc = await host.start();
});
afterAll(async () => {
  await host.stop();
  rmSync(root, { recursive: true, force: true });
});

const request = (port: number, over: Record<string, unknown> = {}) => ({
  knowns_ui: 1,
  type: "listen",
  version: VERSION,
  token: desc.token,
  pid: process.pid,
  port,
  storeRoot: "",
  projectRoot: "",
  password: "",
  allowedOrigins: [],
  dev: false,
  allowTaskHardDelete: false,
  ...over,
});

function talk(
  frame: Record<string, unknown>,
): Promise<{ sock: net.Socket; reply: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: desc.address });
    let buf = "";
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve({ sock, reply: JSON.parse(buf.slice(0, nl)) });
    });
    sock.once("connect", () => sock.write(`${JSON.stringify(frame)}\n`));
  });
}

const freePort = async (): Promise<number> => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
};
const answers = async (port: number): Promise<boolean> => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
};
const until = async (cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return false;
};

describe("ui host", () => {
  test("serves on the requested port and frees it when the control connection closes", async () => {
    const port = await freePort();
    const { sock, reply } = await talk(request(port));
    expect(reply.type).toBe("listening");
    expect(reply.port).toBe(port);
    expect(await answers(port)).toBe(true);
    expect(host.listeners().map((l) => l.port)).toEqual([port]);
    sock.destroy();
    expect(await until(async () => !(await answers(port)), 2000)).toBe(true);
    expect(await until(() => host.listeners().length === 0, 2000)).toBe(true);
    // The same port can be reopened at once.
    const again = await talk(request(port));
    expect(again.reply.port).toBe(port);
    again.sock.destroy();
    expect(await until(async () => !(await answers(port)), 2000)).toBe(true);
  });

  test("a busy port moves to the next free one", async () => {
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy"),
    });
    const { sock, reply } = await talk(request(blocker.port as number));
    expect(reply.type).toBe("listening");
    expect(reply.port).not.toBe(blocker.port);
    sock.destroy();
    blocker.stop(true);
  });

  test("a wrong token and a wrong version are refused and nothing listens", async () => {
    const port = await freePort();
    const bad = await talk(request(port, { token: "0".repeat(64) }));
    expect(bad.reply.code).toBe("unauthorized");
    const old = await talk(request(port, { version: "0.0.0-other" }));
    expect(old.reply.code).toBe("version_mismatch");
    expect(await answers(port)).toBe(false);
    expect(host.listeners()).toEqual([]);
  });

  test("a dead owner pid stops the listener within a few seconds", async () => {
    const port = await freePort();
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
    const { sock, reply } = await talk(request(port, { pid: child.pid }));
    expect(reply.type).toBe("listening");
    child.kill();
    await child.exited;
    expect(await until(async () => !(await answers(port)), 6000)).toBe(true);
    sock.destroy();
  }, 15_000);

  test("stopping the host says bye, frees every port and removes the descriptor", async () => {
    const own = new UiHost({
      root: mkdtempSync(join(tmpdir(), "knowns-ui-host2-")),
      logger: () => undefined,
      serve: async (_r, bind) => {
        const bound = await bind(async () => new Response("x"));
        let fin: () => void = () => {};
        const done = new Promise<void>((r) => {
          fin = r;
        });
        return {
          port: bound.port,
          done,
          stop: () => {
            bound.bun.stop(true);
            fin();
          },
        };
      },
    });
    const d = await own.start();
    const port = await freePort();
    const got = await new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = [];
      let buf = "";
      const sock = net.connect({ path: d.address });
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          frames.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (frames.length === 1) void own.stop("shutdown");
        }
      });
      sock.on("close", () => resolve(frames));
      sock.once("connect", () =>
        sock.write(`${JSON.stringify({ ...request(port), token: d.token })}\n`),
      );
    });
    expect(got.map((f) => f.type)).toEqual(["listening", "bye"]);
    expect(await answers(port)).toBe(false);
  });
});

// --- review follow-ups (ca1e097) ---------------------------------------------------------------

type Stub = {
  port: number;
  done: Promise<void>;
  stop(): void;
  finish(): void;
  fail(e: Error): void;
};
function stubServe(delayMs = 0, out: { last?: Stub; stops: number } = { stops: 0 }) {
  const serve: NonNullable<ConstructorParameters<typeof UiHost>[0]>["serve"] = async (_r, bind) => {
    const bound = await bind(async () => new Response("x"));
    if (delayMs > 0) await Bun.sleep(delayMs);
    let resolve: () => void = () => {};
    let reject: (e: Error) => void = () => {};
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const stub: Stub = {
      port: bound.port,
      done,
      stop: () => {
        out.stops++;
        bound.bun.stop(true);
        resolve();
      },
      finish: () => {
        bound.bun.stop(true);
        resolve();
      },
      fail: (e) => {
        bound.bun.stop(true);
        reject(e);
      },
    };
    out.last = stub;
    return stub;
  };
  return { serve, out };
}
const newHost = (serve: ReturnType<typeof stubServe>["serve"]) =>
  new UiHost({
    root: mkdtempSync(join(tmpdir(), "knowns-ui-host3-")),
    logger: () => undefined,
    serve,
  });

function frames(path: string, send: Record<string, unknown>) {
  const got: Record<string, unknown>[] = [];
  let buf = "";
  const sock = net.connect({ path });
  sock.on("error", () => undefined);
  sock.on("data", (c) => {
    buf += c.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      got.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  sock.once("connect", () => sock.write(`${JSON.stringify(send)}\n`));
  const closed = new Promise<void>((r) => sock.on("close", () => r()));
  return { sock, got, closed };
}

describe("review follow-ups", () => {
  test("a listener stopped on its own says bye stopped", async () => {
    const { serve, out } = stubServe();
    const h = newHost(serve);
    const d = await h.start();
    const port = await freePort();
    const c = frames(d.address, { ...request(port), token: d.token });
    expect(await until(() => c.got.length === 1, 2000)).toBe(true);
    out.last?.finish(); // what POST /api/shutdown does
    await c.closed;
    expect(c.got.map((f) => f.type)).toEqual(["listening", "bye"]);
    expect(c.got[1]?.reason).toBe("stopped");
    await h.stop();
  });

  test("a listener whose shutdown throws does not crash the daemon", async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown): void => void seen.push(e);
    process.on("unhandledRejection", onRej);
    const { serve, out } = stubServe();
    const h = newHost(serve);
    const d = await h.start();
    const port = await freePort();
    const c = frames(d.address, { ...request(port), token: d.token });
    expect(await until(() => c.got.length === 1, 2000)).toBe(true);
    out.last?.fail(new Error("EBUSY: .server-port"));
    await c.closed;
    await Bun.sleep(50);
    process.off("unhandledRejection", onRej);
    expect(seen).toEqual([]);
    expect(h.listeners()).toEqual([]);
    await h.stop();
  });

  test("a client that gives up while the server starts leaves no listener behind", async () => {
    const { serve, out } = stubServe(400);
    const h = newHost(serve);
    const d = await h.start();
    const port = await freePort();
    const c = frames(d.address, { ...request(port), token: d.token });
    await Bun.sleep(100);
    c.sock.destroy(); // gave up
    expect(await until(() => out.stops === 1, 3000)).toBe(true);
    expect(await until(async () => !(await answers(port)), 2000)).toBe(true);
    expect(h.listeners()).toEqual([]);
    await h.stop();
  });

  test("stopping the host while a server starts drops that listener too", async () => {
    const { serve, out } = stubServe(400);
    const h = newHost(serve);
    const d = await h.start();
    const port = await freePort();
    const c = frames(d.address, { ...request(port), token: d.token });
    await Bun.sleep(100);
    await h.stop();
    expect(await until(() => out.stops === 1, 3000)).toBe(true);
    expect(await until(async () => !(await answers(port)), 2000)).toBe(true);
    c.sock.destroy();
  });

  test("start refuses a live endpoint, replaces a stale socket, and cleans up when it cannot publish", async () => {
    const { serve } = stubServe();
    const root2 = mkdtempSync(join(tmpdir(), "knowns-ui-host4-"));
    const a = new UiHost({ root: root2, logger: () => undefined, serve });
    await a.start();
    const b = new UiHost({ root: root2, logger: () => undefined, serve });
    await expect(b.start()).rejects.toThrow(/already active/);
    await a.stop();
    // The descriptor directory cannot be created: the socket must not stay open.
    const root3 = mkdtempSync(join(tmpdir(), "knowns-ui-host5-"));
    await Bun.write(join(root3, "ui"), "not a directory");
    const c = new UiHost({ root: root3, logger: () => undefined, serve });
    await expect(c.start()).rejects.toThrow();
    // A new host on the same root can listen: nothing from the failed start is left holding it.
    await Bun.file(join(root3, "ui")).exists();
    rmSync(join(root3, "ui"), { force: true });
    const d = new UiHost({ root: root3, logger: () => undefined, serve });
    await d.start();
    await d.stop();
  });
});
