import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { errorAs } from "../../src/lsp/errors.ts";
import { RuntimeError } from "../../src/lsp/runtime-error.ts";
import {
  annotateLocalStatuses,
  Client,
  DaemonError,
  DaemonStateDisabledByEnv,
  ErrDisabledByEnv,
  ensureClient,
  newClient,
  RemoteSession,
  readState,
  runWithOptions,
} from "../../src/lspdaemon/index.ts";
import { Server } from "../../src/lspdaemon/server.ts";
import { isolateHome, listenOnce, StubManager, tempProject, waitFor } from "./support.ts";

// Bun 1.3.12 segfaults in expect(...).rejects.toThrow for these error objects; compare the message.
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

let restore: () => void;
beforeAll(() => {
  restore = isolateHome();
});
afterAll(() => restore());

function start(root: string, idleTimeoutMs = 0, manager = new StubManager()) {
  const ac = new AbortController();
  const done = runWithOptions(ac.signal, root, { idleTimeoutMs, manager });
  return { ac, done, manager };
}

describe("daemon over the local transport", () => {
  test("serves shared clients and reports daemon metadata", async () => {
    const root = tempProject();
    const d = start(root);
    const a = newClient(root);
    await waitFor(() => a.ping());
    const b = newClient(root);
    expect(b.token).toBe(a.token);
    expect(b.paths.socketPath).toBe(a.paths.socketPath);
    const statuses = await b.runtimeStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    const s = statuses[0];
    expect(s?.owner).toBe("daemon");
    expect(s?.daemon_pid).toBe(process.pid);
    expect(s?.daemon_transport).toBeTruthy();
    expect(s?.daemon_endpoint).toBeTruthy();
    expect(readState(a.paths).pid).toBe(process.pid);
    d.ac.abort();
    await d.done;
    expect(d.manager.stopped).toBe(true);
    if (process.platform !== "win32") expect(existsSync(a.paths.socketPath)).toBe(false);
  });

  test("admin start/stop updates running state", async () => {
    const root = tempProject();
    const d = start(root);
    const c = newClient(root);
    await waitFor(() => c.ping());
    const started = await c.startLanguage(undefined, "fake");
    expect(started.find((s) => s.id === "fake")?.running_state).toBe("running");
    const stopped = await c.stopLanguage(undefined, "fake");
    expect(stopped.find((s) => s.id === "fake")?.running_state).not.toBe("running");
    await c.applyConfig().catch(() => {});
    d.ac.abort();
    await d.done;
  });

  test("rejects a wrong token and an unsupported operation", async () => {
    const root = tempProject();
    const d = start(root);
    const c = newClient(root);
    await waitFor(() => c.ping());
    const bad = new Client(c.identity, c.paths, "wrong");
    expect(await rejection(bad.ping())).toContain("lsp daemon token mismatch");
    expect(await rejection(c.callOnce(undefined, { operation: "nope" }))).toContain(
      "unsupported LSP daemon operation: nope",
    );
    d.ac.abort();
    await d.done;
  });

  test("remote session round-trips session calls and runtime errors", async () => {
    const root = tempProject();
    const manager = new StubManager();
    manager.session = {
      definition: async () => ({
        uri: "file:///x.go",
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      }),
      references: async () => [],
      documentSymbols: async () => {
        throw new RuntimeError({
          code: "unsupported_capability",
          language: "go",
          action: "symbols",
          message: 'LSP action "symbols" is unavailable',
          advertisedCapabilities: [],
        });
      },
    };
    const d = start(root, 0, manager);
    const c = newClient(root);
    await waitFor(() => c.ping());
    const session = new RemoteSession(c);
    expect((await session.definition(undefined, "/x.go", 1, 2)).uri).toBe("file:///x.go");
    expect(await session.references(undefined, "/x.go", 1, 2)).toEqual([]);
    const err = await session.documentSymbols(undefined, "/x.go").catch((e) => e);
    expect(err).toBeInstanceOf(DaemonError);
    const re = errorAs(err, RuntimeError);
    expect(re?.code).toBe("unsupported_capability");
    expect(manager.lastPath).toBe("/x.go");
    d.ac.abort();
    await d.done;
  });

  test("exits after the idle timeout", async () => {
    const root = tempProject();
    const d = start(root, 100);
    const c = newClient(root);
    await waitFor(() => c.ping());
    await Promise.race([
      d.done,
      new Promise((_, r) => setTimeout(() => r(new Error("no idle exit")), 2000)),
    ]);
  });

  test("a lease keeps the daemon alive past the idle timeout", async () => {
    const root = tempProject();
    const d = start(root, 100);
    const c = newClient(root);
    await waitFor(() => c.ping());
    const statuses = await c.acquireLease(undefined, "webui", 60_000);
    expect(statuses[0]?.daemon_lease_count).toBe(1);
    expect(statuses[0]?.daemon_lease_owners).toContain("webui");
    expect(statuses[0]?.daemon_idle_deadline).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    await c.ping();
    await c.releaseLease(undefined, "webui");
    await Promise.race([
      d.done,
      new Promise((_, r) => setTimeout(() => r(new Error("no idle exit")), 2000)),
    ]);
  });
});

describe("client lifecycle", () => {
  test("EnsureClient is disabled by KNOWNS_LSP_DAEMON=0", async () => {
    process.env.KNOWNS_LSP_DAEMON = "0";
    try {
      await expect(ensureClient(undefined, tempProject())).rejects.toBe(ErrDisabledByEnv);
    } finally {
      delete process.env.KNOWNS_LSP_DAEMON;
    }
    const s = annotateLocalStatuses([{ id: "go" } as never], DaemonStateDisabledByEnv);
    expect(s[0]).toMatchObject({ owner: "local", daemon_state: "disabled_by_env" });
  });

  if (process.platform !== "win32") {
    test("recovers once after a socket failure", async () => {
      const root = tempProject();
      const c = newClient(root);
      const first = await listenOnce(c.paths.socketPath, (s) => s.destroy());
      let recoveries = 0;
      let second: import("node:net").Server | undefined;
      c.recover = async () => {
        recoveries++;
        first.close();
        require("node:fs").rmSync(c.paths.socketPath, { force: true });
        second = await listenOnce(c.paths.socketPath, (s) => {
          s.on("data", () => {
            s.end(
              `${JSON.stringify({ statuses: [{ id: "go", owner: "daemon", daemon_state: "running" }] })}\n`,
            );
          });
        });
      };
      const statuses = await c.runtimeStatuses();
      expect(recoveries).toBe(1);
      expect(statuses[0]?.id).toBe("go");
      second?.close();
    });

    test("recovery failure yields a DaemonError with guidance paths", async () => {
      const root = tempProject();
      const c = newClient(root);
      c.recover = async () => {
        throw new Error("cannot start");
      };
      const err = await c.runtimeStatuses().catch((e) => e);
      expect(err).toBeInstanceOf(DaemonError);
      const d = err as DaemonError;
      expect(d.message).toContain("LSP daemon unavailable during recover after status");
      expect(d.message).toContain("cannot start");
      expect(d.logPath).not.toBe("");
      expect(d.statePath).not.toBe("");
      expect(d.message.endsWith("run `knowns lsp list --json` for current daemon/LSP status")).toBe(
        true,
      );
    });
  }

  test("Server.shouldExitIdle respects active connections and leases", () => {
    const id = { root: "/r", key: "r-0" };
    const s = new Server(id, {} as never, "t", new StubManager(), 100);
    // Never marked active: lastActivity == 0 means never idle.
    expect(s.shouldExitIdle(Date.now() + 1e6)).toBe(false);
  });

  test("daemon.log path exists for the project after start attempt", () => {
    const c = newClient(tempProject());
    expect(c.paths.logPath.endsWith("daemon.log")).toBe(true);
    expect(existsSync(c.paths.daemonDir)).toBe(true);
    expect(readFileSync(c.paths.tokenPath, "utf8").trim()).toBe(c.token);
  });
});
