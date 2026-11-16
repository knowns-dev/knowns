// KN-B3NWK3: what a launcher learns when the daemon's listener ends (review of ca1e097, P2-1).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonListener } from "../../src/runtime/ui-client.ts";
import { UiHost } from "../../src/runtime/ui-host.ts";
import { Server } from "../../src/server/index.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const baseReq = (port: number) => ({
  port,
  storeRoot: "",
  projectRoot: "",
  password: "",
  allowedOrigins: [],
  dev: false,
  allowTaskHardDelete: false,
});
const freePort = async (): Promise<number> => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
};

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "knowns-ui-client-"));
  roots.push(root);
  let finish: () => void = () => {};
  const host = new UiHost({
    root,
    logger: () => undefined,
    serve: async (_r, bind) => {
      const bound = await bind(async () => new Response("x"));
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      finish = () => {
        bound.bun.stop(true);
        resolve();
      };
      return { port: bound.port, done, stop: finish };
    },
  });
  return { host, finish: () => finish() };
}

describe("requestDaemonListener end reasons", () => {
  test("POST /api/shutdown style stop is `stopped`", async () => {
    const { host, finish } = makeHost();
    const d = await host.start();
    const out = await requestDaemonListener(baseReq(await freePort()), { descriptor: d });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    finish();
    expect(await out.listener.closed).toBe("stopped");
    await host.stop();
  });

  test("a daemon that exits says `shutdown`", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const out = await requestDaemonListener(baseReq(await freePort()), { descriptor: d });
    if (!out.ok) throw new Error(out.reason);
    await host.stop("shutdown");
    expect(await out.listener.closed).toBe("shutdown");
  });

  test("a connection that just ends is `lost`, and our own release is `released`", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const a = await requestDaemonListener(baseReq(await freePort()), { descriptor: d });
    if (!a.ok) throw new Error(a.reason);
    a.listener.release();
    expect(await a.listener.closed).toBe("released");

    // A fake daemon that answers `listening` and then drops the connection with no word.
    const net = await import("node:net");
    const path = join(mkdtempSync(join(tmpdir(), "knowns-fake-")), "s.sock");
    const srv = net.createServer((sock) => {
      sock.once("data", () => {
        sock.write(`${JSON.stringify({ knowns_ui: 1, type: "listening", port: 1234 })}\n`);
        setTimeout(() => sock.destroy(), 50);
      });
    });
    await new Promise<void>((r) => srv.listen({ path }, () => r()));
    const lost = await requestDaemonListener(baseReq(1234), {
      descriptor: { ...d, address: path, kind: "unix_socket" },
    });
    if (!lost.ok) throw new Error(lost.reason);
    expect(await lost.listener.closed).toBe("lost");
    srv.close();
    await host.stop();
  });

  test("KNOWNS_MCP_PROXY=0 never asks the daemon", async () => {
    const out = await requestDaemonListener(baseReq(6420), { env: { KNOWNS_MCP_PROXY: "0" } });
    expect(out).toEqual({ ok: false, reason: "KNOWNS_MCP_PROXY=0" });
  });
});

describe("Server.attach", () => {
  test("a step of the shutdown failing neither rejects nor stops the rest", async () => {
    const server = new Server(undefined, "", 0, {});
    let stopped = false;
    const bun = {
      stop: () => {
        stopped = true;
        throw new Error("EPERM");
      },
    } as unknown as ReturnType<typeof Bun.serve>;
    const att = server.attach(bun);
    att.stop();
    await att.done; // does not reject
    expect(stopped).toBe(true);
  });
});
