// KN-B3NWK3 / spec D9: the daemon owns a detached UI listener. It outlives the launcher, lives
// while a tab is connected, ends after the idle grace, is shared by a second launcher for the same
// project, and is stopped by `--stop`, by the daemon exiting, and by the UI's own shutdown.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestDaemonListener,
  stopDaemonListeners,
  stopListenersOfAnyVersion,
  takeOverOlderListeners,
} from "../../src/runtime/ui-client.ts";
import { DEFAULT_UI_IDLE_MS, parseUiIdleEnv, UiHost, uiIdleMs } from "../../src/runtime/ui-host.ts";
import { dial } from "../../src/server/listen.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
};
const req = (over: Record<string, unknown> = {}) => ({
  port: 0,
  storeRoot: "",
  projectRoot: "/p/one",
  password: "",
  allowedOrigins: [],
  dev: false,
  allowTaskHardDelete: false,
  mode: "detached" as const,
  ...over,
});

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "knowns-ui-detached-"));
  roots.push(root);
  const servers = new Map<number, { clients(n: number): void; finish(): void }>();
  const host = new UiHost({
    root,
    logger: () => undefined,
    serve: async (_r, bind) => {
      const bound = await bind(async () => new Response("x"));
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      let cb: (n: number) => void = () => {};
      const finish = (): void => {
        bound.bun.stop(true);
        resolve();
      };
      servers.set(bound.port, { clients: (n) => cb(n), finish });
      return {
        port: bound.port,
        done,
        stop: finish,
        onClients: (f) => {
          cb = f;
        },
      };
    },
  });
  return { host, servers };
}
const listen = async (d: Awaited<ReturnType<UiHost["start"]>>, over = {}) => {
  const p = await freePort();
  const out = await requestDaemonListener(req({ port: p, ...over }), { descriptor: d });
  if (!out.ok) throw new Error(out.reason);
  return out.listener;
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(20);
  }
  return false;
};

describe("detached listener", () => {
  test("the launcher disconnects and the daemon keeps serving", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 60_000 });
    expect(await l.closed).toBe("lost"); // the daemon closed the control connection right away
    expect(host.listeners()).toHaveLength(1);
    expect(host.listeners()[0]?.detached).toBe(true);
    expect(await dial("127.0.0.1", l.port, 300)).toBe(true);
    await host.stop();
    expect(await dial("127.0.0.1", l.port, 300)).toBe(false);
  });

  test("a lease listener is still a lease: closing the connection stops it", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const out = await requestDaemonListener(req({ port: await freePort(), mode: "lease" }), {
      descriptor: d,
    });
    if (!out.ok) throw new Error(out.reason);
    expect(host.listeners()[0]?.detached).toBe(false);
    out.listener.release();
    expect(await until(() => host.listeners().length === 0)).toBe(true);
    await host.stop();
  });
});

describe("idle grace", () => {
  test("a listener nobody connects to ends after the grace, and frees its port", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 150 });
    expect(await until(() => host.listeners().length === 0)).toBe(true);
    expect(await dial("127.0.0.1", l.port, 300)).toBe(false);
    await host.stop();
  });

  test("a connected tab keeps it up; the grace starts when the last tab leaves", async () => {
    const { host, servers } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 250 });
    const s = servers.get(l.port);
    s?.clients(1);
    s?.clients(2);
    await Bun.sleep(500);
    expect(host.listeners()).toHaveLength(1);
    s?.clients(1);
    await Bun.sleep(400);
    expect(host.listeners()).toHaveLength(1);
    s?.clients(0);
    await Bun.sleep(100);
    expect(host.listeners()).toHaveLength(1);
    expect(await until(() => host.listeners().length === 0)).toBe(true);
    expect(await dial("127.0.0.1", l.port, 300)).toBe(false);
    await host.stop();
  });

  test("a tab that comes back inside the grace cancels it", async () => {
    const { host, servers } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 300 });
    const s = servers.get(l.port);
    s?.clients(1);
    s?.clients(0);
    await Bun.sleep(150);
    s?.clients(1);
    await Bun.sleep(400);
    expect(host.listeners()).toHaveLength(1);
    await host.stop();
  });

  test("the default is 30 minutes and KNOWNS_UI_IDLE_MS (or the request) overrides it", () => {
    expect(uiIdleMs(undefined, {})).toBe(DEFAULT_UI_IDLE_MS);
    expect(DEFAULT_UI_IDLE_MS).toBe(30 * 60_000);
    expect(uiIdleMs(undefined, { KNOWNS_UI_IDLE_MS: "5000" })).toBe(5000);
    expect(uiIdleMs(undefined, { KNOWNS_UI_IDLE_MS: "junk" })).toBe(DEFAULT_UI_IDLE_MS);
    expect(uiIdleMs(700, { KNOWNS_UI_IDLE_MS: "5000" })).toBe(700);
  });
});

describe("keep alive (KN-68VX5S)", () => {
  test("idleMs 0 never closes an idle listener, and --stop still does", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 0 });
    expect(l.idleMs).toBe(0);
    await Bun.sleep(400);
    expect(host.listeners()).toHaveLength(1);
    expect(await dial("127.0.0.1", l.port, 300)).toBe(true);
    expect(await stopDaemonListeners({ port: l.port }, { descriptor: d })).toEqual([l.port]);
    expect(await until(async () => !(await dial("127.0.0.1", l.port, 200)))).toBe(true);
    await host.stop();
  });

  test("a tab coming and going does not arm a timer when the grace is 0", async () => {
    const { host, servers } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 0 });
    const s = servers.get(l.port);
    s?.clients(1);
    s?.clients(0);
    await Bun.sleep(300);
    expect(host.listeners()).toHaveLength(1);
    await host.stop();
  });

  test("a later --keep-alive turns a running listener into one that stays, and says so", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const a = await listen(d, { idleMs: 200 });
    expect(a.idleMs).toBe(200);
    const b = await requestDaemonListener(req({ port: a.port, idleMs: 0 }), { descriptor: d });
    if (!b.ok) throw new Error(b.reason);
    expect(b.listener.reused).toBe(true);
    expect(b.listener.idleMs).toBe(0);
    await Bun.sleep(500);
    expect(host.listeners()).toHaveLength(1);
    await host.stop();
  });

  test("KNOWNS_UI_IDLE_MS: 0 keeps, a positive number is the grace, junk is the default", () => {
    expect(parseUiIdleEnv({ KNOWNS_UI_IDLE_MS: "0" })).toBe(0);
    expect(parseUiIdleEnv({ KNOWNS_UI_IDLE_MS: "5000" })).toBe(5000);
    expect(parseUiIdleEnv({ KNOWNS_UI_IDLE_MS: "-1" })).toBeUndefined();
    expect(parseUiIdleEnv({ KNOWNS_UI_IDLE_MS: "junk" })).toBeUndefined();
    expect(parseUiIdleEnv({ KNOWNS_UI_IDLE_MS: "" })).toBeUndefined();
    expect(parseUiIdleEnv({})).toBeUndefined();
    expect(uiIdleMs(undefined, { KNOWNS_UI_IDLE_MS: "0" })).toBe(0);
  });
});

describe("upgrade takeover (KN-ZV8WGG)", () => {
  async function twoVersions() {
    const root = mkdtempSync(join(tmpdir(), "knowns-ui-upgrade-"));
    roots.push(root);
    const mk = (version: string) => {
      const host = new UiHost({
        root,
        version,
        logger: () => undefined,
        serve: async (_r, bind) => {
          const bound = await bind(async () => new Response("x"));
          let resolve: () => void = () => {};
          const done = new Promise<void>((r) => {
            resolve = r;
          });
          return {
            port: bound.port,
            done,
            stop: () => {
              bound.bun.stop(true);
              resolve();
            },
          };
        },
      });
      return host;
    };
    const oldHost = mk("0.0.1");
    const oldD = await oldHost.start();
    return { root, oldHost, oldD, mk };
  }

  test("the older version's listener of this project is replaced on its own port", async () => {
    const { root, oldHost, oldD } = await twoVersions();
    const old = await requestDaemonListener(req({ port: await freePort(), idleMs: 60_000 }), {
      descriptor: oldD,
    });
    if (!old.ok) throw new Error(old.reason);
    const other = await requestDaemonListener(
      req({ port: await freePort(), idleMs: 60_000, projectRoot: "/p/other" }),
      { descriptor: oldD },
    );
    if (!other.ok) throw new Error(other.reason);
    const freed = await takeOverOlderListeners(
      { projectRoot: "/p/one", port: old.listener.port, password: "" },
      { root },
    );
    expect(freed).toEqual([old.listener.port]);
    expect(await dial("127.0.0.1", old.listener.port, 200)).toBe(false);
    // Another project's UI is left alone.
    expect(await dial("127.0.0.1", other.listener.port, 200)).toBe(true);
    await oldHost.stop();
  });

  test("--stop reaches a listener of an older version by port or by project", async () => {
    const { root, oldHost, oldD } = await twoVersions();
    const mkOld = async (projectRoot: string) => {
      const o = await requestDaemonListener(
        req({ port: await freePort(), idleMs: 60_000, projectRoot }),
        { descriptor: oldD },
      );
      if (!o.ok) throw new Error(o.reason);
      return o.listener.port;
    };
    const byPort = await mkOld("/p/one");
    expect(await stopListenersOfAnyVersion({ port: byPort }, { root })).toEqual([byPort]);
    expect(await dial("127.0.0.1", byPort, 200)).toBe(false);
    const byProject = await mkOld("/p/two");
    expect(await stopListenersOfAnyVersion({ projectRoot: "/p/two" }, { root })).toEqual([
      byProject,
    ]);
    expect(await dial("127.0.0.1", byProject, 200)).toBe(false);
    await oldHost.stop();
  });

  test("nothing to take over when no older daemon runs, or none serves this project", async () => {
    const { root, oldHost } = await twoVersions();
    expect(
      await takeOverOlderListeners({ projectRoot: "/p/one", port: 6420, password: "" }, { root }),
    ).toEqual([]);
    expect(
      await takeOverOlderListeners({ projectRoot: "", port: 6420, password: "" }, { root }),
    ).toEqual([]);
    await oldHost.stop();
    expect(
      await takeOverOlderListeners({ projectRoot: "/p/one", port: 6420, password: "" }, { root }),
    ).toEqual([]);
  });

  test("a password-protected older UI is not replaced by one without a password", async () => {
    const { root, oldHost, oldD } = await twoVersions();
    const port = await freePort();
    const guard = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ authenticated: false, protected: true }),
    });
    const freed = await takeOverOlderListeners(
      { projectRoot: "/p/one", port, password: "" },
      { root, range: 1 },
    );
    expect(freed).toEqual([]);
    guard.stop(true);
    void oldD;
    await oldHost.stop();
  });
});

describe("reuse", () => {
  test("a second launcher for the same project gets the running port", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const a = await listen(d, { idleMs: 60_000 });
    expect(a.reused).toBe(false);
    const b = await listen(d, { idleMs: 60_000 });
    expect(b.reused).toBe(true);
    expect(b.port).toBe(a.port);
    expect(host.listeners()).toHaveLength(1);
    // Another project, or another password, is its own listener.
    const c = await listen(d, { idleMs: 60_000, projectRoot: "/p/two" });
    const e = await listen(d, { idleMs: 60_000, password: "secret" });
    expect(new Set([a.port, c.port, e.port]).size).toBe(3);
    expect(host.listeners()).toHaveLength(3);
    await host.stop();
  });
});

describe("stopping", () => {
  test("--stop by port and by project frees the port and reports it", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const a = await listen(d, { idleMs: 60_000 });
    const b = await listen(d, { idleMs: 60_000, projectRoot: "/p/two" });
    expect(await stopDaemonListeners({ port: a.port }, { descriptor: d })).toEqual([a.port]);
    expect(await dial("127.0.0.1", a.port, 300)).toBe(false);
    expect(host.listeners()).toHaveLength(1);
    expect(await stopDaemonListeners({ projectRoot: "/p/two" }, { descriptor: d })).toEqual([
      b.port,
    ]);
    expect(await dial("127.0.0.1", b.port, 300)).toBe(false);
    expect(await stopDaemonListeners({ port: 1 }, { descriptor: d })).toEqual([]);
    await host.stop();
  });

  test("a stop without a target, or with a bad token, is refused", async () => {
    const { host } = makeHost();
    const d = await host.start();
    await listen(d, { idleMs: 60_000 });
    expect(await stopDaemonListeners({}, { descriptor: d })).toBeUndefined();
    expect(
      await stopDaemonListeners({ port: 1 }, { descriptor: { ...d, token: "x" } }),
    ).toBeUndefined();
    expect(host.listeners()).toHaveLength(1);
    await host.stop();
  });

  test("the UI's own shutdown control ends a detached listener", async () => {
    const { host, servers } = makeHost();
    const d = await host.start();
    const l = await listen(d, { idleMs: 60_000 });
    servers.get(l.port)?.finish(); // what POST /api/shutdown does: the server's done settles
    expect(await until(() => host.listeners().length === 0)).toBe(true);
    await host.stop();
  });

  test("the daemon exiting frees every detached port", async () => {
    const { host } = makeHost();
    const d = await host.start();
    const a = await listen(d, { idleMs: 60_000 });
    const b = await listen(d, { idleMs: 60_000, projectRoot: "/p/two" });
    await host.stop("shutdown");
    expect(host.listeners()).toHaveLength(0);
    expect(await dial("127.0.0.1", a.port, 300)).toBe(false);
    expect(await dial("127.0.0.1", b.port, 300)).toBe(false);
  });
});
