// The launcher side of the daemon's UI host (@task-KN-B3NWK3): ask the runtime daemon to serve the
// web UI on a port. Returns undefined, with the reason, whenever the daemon cannot do it, and the
// caller then runs its own server as `knowns browser` always did (spec D6, FR-9).
import net from "node:net";
import { VERSION } from "../version.ts";
import { proxyEnabled } from "./proxy-mode.ts";
import { ensureDaemon, isProcessAlive, shouldBypassDaemon } from "./queue.ts";
import { readUiDescriptor, type UiListenRequest } from "./ui-host.ts";

export interface DaemonListener {
  port: number;
  /** Settles when the daemon side of the connection ends (listener stopped, daemon gone). */
  closed: Promise<void>;
  /** Releases the listener: the daemon frees the port. */
  release(): void;
}

export type DaemonListenOutcome =
  | { ok: true; listener: DaemonListener }
  | { ok: false; reason: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function requestDaemonListener(
  req: UiListenRequest,
  opts: { env?: Record<string, string | undefined>; waitMs?: number; replyMs?: number } = {},
): Promise<DaemonListenOutcome> {
  const env = opts.env ?? process.env;
  if (!proxyEnabled(env)) return { ok: false, reason: "KNOWNS_MCP_PROXY=0" };
  if (shouldBypassDaemon()) return { ok: false, reason: "runtime daemon is disabled" };
  try {
    ensureDaemon();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  let desc = readUiDescriptor(VERSION);
  while ((!desc || !isProcessAlive(desc.pid)) && Date.now() < deadline) {
    await sleep(100);
    desc = readUiDescriptor(VERSION);
  }
  if (!desc || !isProcessAlive(desc.pid)) return { ok: false, reason: "daemon has no UI endpoint" };

  const sock = net.connect({ path: desc.address });
  sock.on("error", () => undefined);
  let buf = "";
  let onClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    onClosed = r;
  });
  sock.on("close", () => onClosed());
  const reply = await new Promise<Record<string, unknown> | string>((resolve) => {
    const timer = setTimeout(() => resolve("no reply from the daemon"), opts.replyMs ?? 15_000);
    const done = (v: Record<string, unknown> | string): void => {
      clearTimeout(timer);
      sock.off("data", onData);
      resolve(v);
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        done(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch {
        done("unreadable reply from the daemon");
      }
      buf = buf.slice(nl + 1);
    };
    sock.on("data", onData);
    sock.once("close", () => done("daemon closed the connection"));
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
  });
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
    listener: { port: reply.port, closed, release: () => sock.destroy() },
  };
}
