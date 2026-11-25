// The launcher side of the daemon's UI host (@task-KN-B3NWK3): ask the runtime daemon to serve the
// web UI on a port. Returns undefined, with the reason, whenever the daemon cannot do it, and the
// caller then runs its own server as `knowns browser` always did (spec D6, FR-9).
import { readdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { dial } from "../server/listen.ts";
import { VERSION } from "../version.ts";
import { compareVersions, findDaemon } from "./daemon-registry.ts";
import { proxyEnabled } from "./proxy-mode.ts";
import { ensureDaemon, isProcessAlive, runtimeRoot, shouldBypassDaemon } from "./queue.ts";
import { readUiDescriptor, type UiDescriptor, type UiListenRequest } from "./ui-host.ts";

/**
 * Why a daemon listener ended.
 * - `stopped`: the listener was stopped on purpose (POST /api/shutdown); the user is done.
 * - `released`: this launcher let go of it.
 * - `shutdown`: the daemon is exiting (bye shutdown, `runtime stop`, an upgrade).
 * - `lost`: the connection ended with no word (the daemon crashed or was killed).
 */
export type ListenerEnd = "stopped" | "released" | "shutdown" | "lost";

export interface DaemonListener {
  port: number;
  /** Detached listener that was already running for this project. */
  reused: boolean;
  /** Detached only: the idle grace in force in ms (0 = until stopped); undefined from an older daemon. */
  idleMs: number | undefined;
  /** Settles when the daemon side of the connection ends. */
  closed: Promise<ListenerEnd>;
  /** Releases the listener: the daemon frees the port. */
  release(): void;
}

export type DaemonListenOutcome =
  | { ok: true; listener: DaemonListener }
  | { ok: false; reason: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function requestDaemonListener(
  req: UiListenRequest,
  opts: {
    env?: Record<string, string | undefined>;
    waitMs?: number;
    replyMs?: number;
    /** Tests: connect to this endpoint without starting or looking for a daemon. */
    descriptor?: UiDescriptor;
  } = {},
): Promise<DaemonListenOutcome> {
  const env = opts.env ?? process.env;
  if (!proxyEnabled(env)) return { ok: false, reason: "KNOWNS_MCP_PROXY=0" };
  const given = opts.descriptor;
  if (!given && shouldBypassDaemon()) return { ok: false, reason: "runtime daemon is disabled" };
  // A daemon of this version that was already running and has no UI endpoint will never get one
  // (an older build): do not wait for it.
  const wasRunning = !given && findDaemon(VERSION) !== undefined;
  if (!given) {
    try {
      ensureDaemon();
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
  const deadline = Date.now() + (wasRunning ? 1_000 : (opts.waitMs ?? 10_000));
  let desc = given ?? readUiDescriptor(VERSION);
  while ((!desc || !isProcessAlive(desc.pid)) && Date.now() < deadline) {
    await sleep(100);
    desc = readUiDescriptor(VERSION);
  }
  if (!desc || !isProcessAlive(desc.pid)) return { ok: false, reason: "daemon has no UI endpoint" };

  const sock = net.connect({ path: desc.address });
  sock.on("error", () => undefined);
  let buf = "";
  let end: ListenerEnd = "lost";
  let announced = false;
  let onFirst: (v: Record<string, unknown> | string) => void = () => {};
  let onClosed: (v: ListenerEnd) => void = () => {};
  const closed = new Promise<ListenerEnd>((r) => {
    onClosed = r;
  });
  const first = new Promise<Record<string, unknown> | string>((r) => {
    onFirst = r;
  });
  const timer = setTimeout(() => onFirst("no reply from the daemon"), opts.replyMs ?? 15_000);
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (!announced) onFirst("unreadable reply from the daemon");
        continue;
      }
      if (!announced) {
        announced = true;
        clearTimeout(timer);
        onFirst(m);
      } else if (m.type === "bye") {
        end = m.reason === "stopped" ? "stopped" : "shutdown";
      }
    }
  });
  sock.once("close", () => {
    clearTimeout(timer);
    if (!announced) onFirst("daemon closed the connection");
    onClosed(end);
  });
  sock.once("connect", () => {
    sock.write(
      `${JSON.stringify({
        knowns_ui: 1,
        type: "listen",
        version: desc?.version ?? VERSION,
        token: desc?.token,
        pid: process.pid,
        ...req,
      })}\n`,
    );
  });

  const reply = await first;
  if (typeof reply === "string" || reply.type !== "listening" || typeof reply.port !== "number") {
    sock.destroy();
    const why =
      typeof reply === "string"
        ? reply
        : `${String(reply.code ?? "error")}: ${String(reply.message ?? "")}`;
    return { ok: false, reason: why };
  }
  return {
    ok: true,
    listener: {
      port: reply.port,
      reused: reply.reused === true,
      idleMs: typeof reply.idleMs === "number" ? reply.idleMs : undefined,
      closed,
      release: () => {
        end = "released";
        sock.destroy();
      },
    },
  };
}

/**
 * Asks the daemon to stop the UI listeners on a port or of a project (`knowns browser --stop`).
 * Returns the ports it stopped, or undefined when there is no daemon to ask.
 */
export async function stopDaemonListeners(
  target: { port?: number; projectRoot?: string },
  opts: {
    env?: Record<string, string | undefined>;
    descriptor?: UiDescriptor;
    replyMs?: number;
  } = {},
): Promise<number[] | undefined> {
  const desc = opts.descriptor ?? readUiDescriptor(VERSION);
  if (!desc || !isProcessAlive(desc.pid)) return undefined;
  return await new Promise<number[] | undefined>((resolve) => {
    const sock = net.connect({ path: desc.address });
    let buf = "";
    const done = (v: number[] | undefined): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), opts.replyMs ?? 10_000);
    sock.on("error", () => done(undefined));
    sock.once("close", () => done(undefined));
    sock.once("connect", () =>
      sock.write(
        `${JSON.stringify({ knowns_ui: 1, type: "stop", version: desc.version, token: desc.token, ...target })}\n`,
      ),
    );
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const m = JSON.parse(buf.slice(0, nl)) as { type?: string; ports?: unknown };
        done(m.type === "stopped" && Array.isArray(m.ports) ? (m.ports as number[]) : undefined);
      } catch {
        done(undefined);
      }
    });
  });
}

/** The UI endpoints of live daemons of OLDER versions (an upgrade leaves them running). */
export function olderUiDescriptors(root: string = runtimeRoot()): UiDescriptor[] {
  let names: string[];
  try {
    names = readdirSync(join(root, "ui"));
  } catch {
    return [];
  }
  const out: UiDescriptor[] = [];
  for (const n of names) {
    const m = /^control-(.+)\.json$/.exec(n);
    if (!m) continue;
    const d = readUiDescriptor(m[1] as string, root);
    if (!d || compareVersions(d.version, VERSION) >= 0 || !isProcessAlive(d.pid)) continue;
    out.push(d);
  }
  return out;
}

/** True when a Knowns UI answering on `port` asks for a password. Anything else is false. */
async function protectedUi(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      signal: AbortSignal.timeout(1000),
    });
    const j = (await res.json()) as { protected?: unknown };
    return j.protected === true;
  } catch {
    return false;
  }
}

/**
 * After an upgrade the previous version's daemon still holds the UI port of this project, so a new
 * `knowns browser` would move to the next port and the open tab would keep the old UI. Stops the
 * detached and leased UI listeners OF THIS PROJECT in older daemons (each daemon answers for its
 * own listeners only, and only the project asked for), waits for their ports to free, and returns
 * them so the caller can serve on the same port. Returns [] when there is nothing to take over,
 * or when an older UI in the port range is password-protected and the new one would not be: a
 * takeover must never silently drop the password.
 */
export async function takeOverOlderListeners(
  target: { projectRoot: string; port: number; password: string },
  opts: { root?: string; replyMs?: number; range?: number } = {},
): Promise<number[]> {
  if (target.projectRoot === "") return [];
  const olds = olderUiDescriptors(opts.root);
  if (olds.length === 0) return [];
  if (target.password === "") {
    for (let i = 0; i < (opts.range ?? 10); i++) {
      if (await protectedUi(target.port + i)) return [];
    }
  }
  const ports: number[] = [];
  for (const d of olds) {
    const stopped = await stopDaemonListeners(
      { projectRoot: target.projectRoot },
      { descriptor: d, ...(opts.replyMs !== undefined && { replyMs: opts.replyMs }) },
    );
    if (stopped) ports.push(...stopped);
  }
  const deadline = Date.now() + 5_000;
  for (const p of ports) {
    while (Date.now() < deadline && (await dial("127.0.0.1", p, 200))) await sleep(50);
  }
  return ports;
}

/**
 * `knowns browser --stop`: the listeners of this version's daemon AND of older daemons an upgrade
 * left running, so the UI on a port stops whichever version serves it (KN-ZV8WGG). Returns the
 * ports stopped, or undefined when no daemon answered at all.
 */
export async function stopListenersOfAnyVersion(
  target: { port?: number; projectRoot?: string },
  opts: { root?: string; replyMs?: number } = {},
): Promise<number[] | undefined> {
  const ro = opts.replyMs !== undefined ? { replyMs: opts.replyMs } : {};
  const own = await stopDaemonListeners(target, ro);
  let answered = own !== undefined;
  const ports = [...(own ?? [])];
  for (const d of olderUiDescriptors(opts.root)) {
    const stopped = await stopDaemonListeners(target, { descriptor: d, ...ro });
    if (stopped !== undefined) answered = true;
    ports.push(...(stopped ?? []));
  }
  return answered ? [...new Set(ports)] : undefined;
}
