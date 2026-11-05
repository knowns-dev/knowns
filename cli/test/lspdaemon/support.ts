import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../../src/lsp/context.ts";
import type { LanguageRuntimeStatus, Session } from "../../src/lsp/types.ts";
import type { DaemonManager } from "../../src/lspdaemon/server.ts";

/** Isolates HOME for the test file; returns a restore function. */
export function isolateHome(): () => void {
  const prev = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lspd-home-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  };
}

export function tempProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lspd-proj-")));
  mkdirSync(join(dir, ".knowns"), { recursive: true });
  return dir;
}

export async function waitFor(fn: () => Promise<void> | void, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  // Windows: a pipe client in the server's own process blocks the loop that must create the next
  // instance; yield once so the in-process server is listening before the first dial.
  await new Promise((r) => setTimeout(r, 20));
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw last;
}

export function listenOnce(path: string, handler: (c: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer(handler);
    s.once("error", reject);
    s.listen({ path }, () => resolve(s));
  });
}

/** A DaemonManager stub that records calls; languages start/stop by id. */
export class StubManager implements DaemonManager {
  running = new Set<string>();
  stopped = false;
  session: Partial<Session> = {};
  lastPath = "";

  async withSession(_ctx: Ctx, path: string, fn: (s: Session) => Promise<void>): Promise<void> {
    this.lastPath = path;
    await fn(this.session as Session);
  }
  async withAnyServer(_ctx: Ctx, fn: (s: Session) => Promise<void>): Promise<void> {
    await fn(this.session as Session);
  }
  async runtimeStatuses(): Promise<LanguageRuntimeStatus[]> {
    return ["fake", "go"].map((id) => ({
      id,
      name: id,
      enabled: true,
      detected: false,
      status: this.running.has(id) ? "running" : "not_installed",
      install_state: "installed",
      running_state: this.running.has(id) ? "running" : "stopped",
      readiness_state: "unknown",
      verified: false,
    }));
  }
  async startLanguage(_ctx: Ctx, id: string): Promise<void> {
    this.running.add(id);
  }
  stopLanguage(id: string): void {
    this.running.delete(id);
  }
  async restartLanguage(_ctx: Ctx, id: string): Promise<void> {
    this.running.add(id);
  }
  setConfig(): void {}
  describeRuntimeError(): null {
    return null;
  }
  async stopAll(): Promise<void> {
    this.stopped = true;
  }
}
