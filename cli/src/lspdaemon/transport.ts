// Ports of transport_unix.go / transport_windows.go: Unix sockets and Windows named pipes, both
// through node:net (a pipe name is just a path for node).
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import type { Ctx } from "../lsp/context.ts";
import { ctxErr } from "../lsp/context.ts";
import { endpoint, type Paths, type TransportEndpoint } from "./identity.ts";

const isWindows = process.platform === "win32";

function enoent(path: string): Error {
  const e = new Error(`connect ENOENT ${path}`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

export class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}

/** Marks an error as a transport failure (Go: *net.OpError / net.Error / io.EOF). */
/** Bun can emit a connect error synchronously; connect on a microtask so the caller's listeners exist. */
function connectPath(path: string): net.Socket {
  const sock = new net.Socket();
  queueMicrotask(() => sock.connect({ path }));
  return sock;
}

export class TransportError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransportError";
    this.cause = cause;
  }
}

export function dialEndpoint(ctx: Ctx, ep: TransportEndpoint): Promise<net.Socket> {
  const want = isWindows ? "windows_pipe" : "unix_socket";
  if (ep.kind !== want) {
    return Promise.reject(new Error(`unsupported LSP daemon transport "${ep.kind}"`));
  }
  return dialOnce(ctx, ep);
}

function dialOnce(ctx: Ctx, ep: TransportEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const e0 = ctxErr(ctx);
    if (e0) return reject(new TransportError(e0));
    // Connecting to a missing socket path trips an uncaught-error report in `bun test` even with
    // an error listener attached, so answer ENOENT ourselves (same error the kernel would give).
    if (!isWindows && !existsSync(ep.address)) {
      return reject(new TransportError(enoent(ep.address)));
    }
    const sock = connectPath(ep.address);
    const onAbort = () => {
      sock.destroy();
      reject(new TransportError(ctxErr(ctx) ?? new Error("context canceled")));
    };
    ctx?.addEventListener("abort", onAbort, { once: true });
    sock.once("connect", () => {
      ctx?.removeEventListener("abort", onAbort);
      resolve(sock);
    });
    sock.on("error", (err) => {
      ctx?.removeEventListener("abort", onAbort);
      reject(new TransportError(err));
    });
  });
}

function removeStaleSocket(path: string): Promise<void> {
  if (path === "") return Promise.reject(new Error("socket path is required"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const sock = connectPath(path);
    const timer = setTimeout(() => {
      sock.destroy();
      settle(false);
    }, 200);
    let done = false;
    const settle = (active: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (active) {
        sock.destroy();
        return reject(new Error(`LSP daemon socket already active: ${path}`));
      }
      try {
        unlinkSync(path);
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") return reject(e);
      }
      resolve();
    };
    sock.once("connect", () => settle(true));
    sock.on("error", () => settle(false));
  });
}

export async function listenEndpoint(paths: Paths): Promise<net.Server> {
  const ep = endpoint(paths);
  if (!isWindows) await removeStaleSocket(ep.address);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: ep.address }, () => {
      server.off("error", reject);
      // Not in Go (umask decides there): the socket sits in a shared temp dir, so only the owner
      // may connect. The token still guards every request.
      if (!isWindows) {
        try {
          chmodSync(ep.address, 0o600);
        } catch {
          // the token check still applies
        }
      }
      resolve();
    });
  });
  return server;
}

export function cleanupEndpoint(paths: Paths): void {
  if (isWindows || paths.socketPath === "") return;
  try {
    unlinkSync(paths.socketPath);
  } catch {
    // already gone
  }
}

/** A request or reply larger than this is refused (Go's decoder has no cap; TS adds one). */
export const MAX_FRAME_BYTES = 16 << 20;

export interface ReadOptions {
  /** Fail when no complete value arrives in time (not in Go; the server uses it so a silent
   * client cannot hold the daemon past its idle exit). */
  timeoutMs?: number;
}

/**
 * Reads one JSON value from the socket (newline terminated or complete at EOF). Go's encoder ends
 * every value with a newline, so parsing waits for one instead of re-parsing on every chunk.
 */
export function readJSON<T>(sock: net.Socket, opts: ReadOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            cleanup();
            reject(new Error("read request: i/o timeout"));
          }, opts.timeoutMs);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("error", onError);
      sock.off("close", onEnd);
    };
    const tryParse = (): boolean => {
      if (buf.trim() === "") return false;
      try {
        const v = JSON.parse(buf) as T;
        cleanup();
        resolve(v);
        return true;
      } catch {
        return false;
      }
    };
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > MAX_FRAME_BYTES) {
        cleanup();
        reject(new Error(`read request: frame exceeds ${MAX_FRAME_BYTES} bytes`));
        return;
      }
      if (d.includes(0x0a)) tryParse();
    };
    const onEnd = () => {
      if (tryParse()) return;
      cleanup();
      if (buf.trim() === "") reject(new EOFError());
      else reject(new Error("unexpected EOF"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new TransportError(err));
    };
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("close", onEnd);
    sock.on("error", onError);
  });
}

export function writeJSON(sock: net.Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    // Bun never runs the write callback when the peer already hung up; settle on end/close too so the
    // caller's reader reports the EOF (Go's Encode would have returned a broken-pipe error instead).
    const settle = (err?: Error | null) => {
      sock.off("end", onEnd);
      sock.off("close", onEnd);
      if (err) reject(new TransportError(err));
      else resolve();
    };
    const onEnd = () => settle();
    sock.once("end", onEnd);
    sock.once("close", onEnd);
    sock.write(`${JSON.stringify(value)}\n`, (err) => settle(err));
  });
}
