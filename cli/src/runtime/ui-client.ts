// The launcher side of the daemon's UI host (@task-KN-B3NWK3): ask the runtime daemon to serve the
// web UI on a port. Returns undefined, with the reason, whenever the daemon cannot do it, and the
// caller then runs its own server as `knowns browser` always did (spec D6, FR-9).
import net from "node:net";
import { VERSION } from "../version.ts";
import { findDaemon } from "./daemon-registry.ts";
import { proxyEnabled } from "./proxy-mode.ts";
import { ensureDaemon, isProcessAlive, shouldBypassDaemon } from "./queue.ts";
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
        version: VERSION,
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
      closed,
      release: () => {
        end = "released";
        sock.destroy();
      },
    },
  };
}
