// The per-connection MCP session host of the runtime daemon (@task-KN-QS0B82). A proxy connects to
// the endpoint, says hello, and from then on the connection is a plain MCP stdio session served by
// its own McpServer + McpState, so project selection, client info, permissions, audit and the
// runtime lease never leak between sessions. Contract: "Daemon MCP endpoint: handshake contract"
// in @doc/specs/2026-11-16/mcp-thin-proxy.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type net from "node:net";
import type { McpLogger } from "../mcp/log.ts";
import { VERSION } from "../version.ts";
import {
  type EndpointDescriptor,
  listenMcpEndpoint,
  PROXY_PROTOCOL,
  removeDescriptor,
} from "./mcp-endpoint.ts";
import { goLogf, isProcessAlive } from "./queue.ts";

export const MAX_FRAME_BYTES = 16 << 20;
const MAX_UNAUTHENTICATED = 8;
const DEFAULT_MAX_SESSIONS = 64;

export type ErrorCode =
  | "bad_hello"
  | "unsupported_protocol"
  | "version_mismatch"
  | "unauthorized"
  | "frame_too_large"
  | "busy"
  | "shutting_down"
  | "internal";

const RETRY_AFTER_MS: Partial<Record<ErrorCode, number>> = { busy: 500, shutting_down: 1000 };

export interface SessionInfo {
  id: string;
  pid: number | undefined;
  client: string;
  project: string;
  startedAt: string;
}

/** What the host needs from an MCP application; newMcpApp in production, a stub in tests. */
export interface HostedApp {
  server: { serve: import("../mcp/server.ts").McpServer["serve"] };
  state: {
    clientInfo: { name: string } | undefined;
    getRoot(): string;
    log: McpLogger;
  };
  begin(): Promise<void>;
  cleanup(reason: string): void;
}

export interface McpHostOptions {
  version?: string;
  root?: string;
  maxSessions?: number;
  helloTimeoutMs?: number;
  ownerCheckMs?: number;
  /** Builds the application for one session. */
  createApp?: (project: string, cwd: string, log: McpLogger) => Promise<HostedApp> | HostedApp;
  logger?: (line: string) => void;
}

interface Hello {
  knowns_mcp: number;
  type: string;
  version: string;
  token: string;
  cwd: string;
  project: string;
  pid: number | undefined;
  client: { name?: string; version?: string };
}

class HandshakeFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function tokenOk(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseHello(line: string): Hello {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new HandshakeFailure("bad_hello", "first frame is not JSON");
  }
  if (!isObject(raw) || raw.type !== "hello" || typeof raw.knowns_mcp !== "number") {
    throw new HandshakeFailure("bad_hello", "first frame must be a hello control frame");
  }
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const cwd = str("cwd");
  if (cwd === "") throw new HandshakeFailure("bad_hello", "hello.cwd is required");
  if (typeof raw.version !== "string" || raw.version === "") {
    throw new HandshakeFailure("bad_hello", "hello.version is required");
  }
  const pid =
    typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : undefined;
  const client = isObject(raw.client)
    ? {
        ...(typeof raw.client.name === "string" ? { name: raw.client.name } : {}),
        ...(typeof raw.client.version === "string" ? { version: raw.client.version } : {}),
      }
    : {};
  return {
    knowns_mcp: raw.knowns_mcp,
    type: "hello",
    version: raw.version,
    token: str("token"),
    cwd,
    project: str("project"),
    pid,
    client,
  };
}

/** A pull queue of byte chunks: serve() reads it as its stdin. */
class Chunks implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(chunk);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
  }
}

interface Live {
  info: SessionInfo;
  sock: net.Socket;
  end(reason: string): void;
}

export class McpHost {
  private readonly version: string;
  private readonly root: string | undefined;
  private readonly sessionsById = new Map<string, Live>();
  private descriptor: EndpointDescriptor | undefined;
  private server: net.Server | undefined;
  private unauthenticated = 0;
  private stopping = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: McpHostOptions = {}) {
    this.version = opts.version ?? VERSION;
    this.root = opts.root;
    this.log = opts.logger ?? goLogf;
  }

  get address(): string | undefined {
    return this.descriptor?.address;
  }

  get token(): string | undefined {
    return this.descriptor?.token;
  }

  sessions(): SessionInfo[] {
    return [...this.sessionsById.values()].map((s) => s.info);
  }

  async start(): Promise<EndpointDescriptor> {
    const { server, descriptor } = await listenMcpEndpoint((sock) => this.onConnection(sock), {
      version: this.version,
      ...(this.root !== undefined ? { root: this.root } : {}),
    });
    this.server = server;
    this.descriptor = descriptor;
    server.on("error", (e) => this.log(`[mcp-host] listener error: ${e.message}`));
    this.log(`[mcp-host] listening (version=${this.version}, kind=${descriptor.kind})`);
    return descriptor;
  }

  /** Says goodbye to every session, stops listening and removes the descriptor. */
  async stop(reason = "shutdown"): Promise<void> {
    this.stopping = true;
    const server = this.server;
    const d = this.descriptor;
    this.server = undefined;
    for (const s of [...this.sessionsById.values()]) s.end(reason);
    if (d) removeDescriptor(d, this.root);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    this.descriptor = undefined;
  }

  evict(id: string): boolean {
    const s = this.sessionsById.get(id);
    if (!s) return false;
    s.end("evicted");
    return true;
  }

  // --- connections -----------------------------------------------------------------------------

  private onConnection(sock: net.Socket): void {
    if (this.unauthenticated >= MAX_UNAUTHENTICATED) {
      sock.destroy();
      return;
    }
    this.unauthenticated++;
    let counted = true;
    const settleCount = (): void => {
      if (!counted) return;
      counted = false;
      this.unauthenticated--;
    };
    sock.on("error", () => undefined); // a reset is a session end, not a daemon error
    sock.on("close", settleCount);

    let buf = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(
      () => fail(new HandshakeFailure("bad_hello", "no hello within the handshake window")),
      this.opts.helloTimeoutMs ?? 5000,
    );
    const fail = (f: HandshakeFailure): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settleCount();
      sock.removeListener("data", onData);
      this.refuse(sock, f);
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_FRAME_BYTES) {
          fail(new HandshakeFailure("frame_too_large", "hello frame too large"));
        }
        return;
      }
      done = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      const rest = buf.subarray(nl + 1);
      let hello: Hello;
      try {
        hello = this.validate(parseHello(line));
      } catch (e) {
        settleCount();
        this.refuse(
          sock,
          e instanceof HandshakeFailure ? e : new HandshakeFailure("internal", String(e)),
        );
        return;
      }
      settleCount();
      this.open(sock, hello, rest);
    };
    sock.on("data", onData);
    sock.on("end", () => {
      if (!done) fail(new HandshakeFailure("bad_hello", "closed before hello"));
    });
  }

  private validate(h: Hello): Hello {
    if (this.stopping) throw new HandshakeFailure("shutting_down", "daemon is shutting down");
    if (h.knowns_mcp !== PROXY_PROTOCOL) {
      throw new HandshakeFailure(
        "unsupported_protocol",
        `proxy protocol ${h.knowns_mcp} is not supported (daemon speaks ${PROXY_PROTOCOL})`,
      );
    }
    const token = this.descriptor?.token ?? "";
    if (token === "" || !tokenOk(token, h.token)) {
      throw new HandshakeFailure("unauthorized", "invalid token");
    }
    if (h.version !== this.version) {
      throw new HandshakeFailure(
        "version_mismatch",
        `daemon is ${this.version}, client is ${h.version}`,
      );
    }
    if (this.sessionsById.size >= (this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
      throw new HandshakeFailure("busy", "session limit reached");
    }
    return h;
  }

  private refuse(sock: net.Socket, f: HandshakeFailure): void {
    const retry = RETRY_AFTER_MS[f.code];
    const frame = {
      knowns_mcp: PROXY_PROTOCOL,
      type: "error",
      code: f.code,
      message: f.message,
      daemon_version: this.version,
      ...(retry !== undefined ? { retry_after_ms: retry } : {}),
    };
    this.log(`[mcp-host] refused connection: ${f.code}`);
    try {
      sock.end(`${JSON.stringify(frame)}\n`);
    } catch {
      sock.destroy();
    }
    // Do not wait for a client that never closes.
    setTimeout(() => sock.destroy(), 2000).unref();
  }

  // --- sessions --------------------------------------------------------------------------------

  private open(sock: net.Socket, hello: Hello, firstBytes: Buffer): void {
    const id = `s-${randomBytes(4).toString("hex")}`;
    const info: SessionInfo = {
      id,
      pid: hello.pid,
      client: hello.client.name ?? "",
      project: "",
      startedAt: new Date().toISOString(),
    };
    const write = (frame: unknown): void => {
      if (sock.destroyed || !sock.writable) return;
      sock.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);
    };
    write({
      knowns_mcp: PROXY_PROTOCOL,
      type: "welcome",
      version: this.version,
      session: id,
      daemon_pid: process.pid,
      max_frame_bytes: MAX_FRAME_BYTES,
    });

    const logger = this.sessionLogger(id);
    let app: HostedApp | undefined;
    const chunks = new Chunks();
    let ended = false;
    let byeReason: string | undefined;
    let ownerTimer: ReturnType<typeof setInterval> | undefined;

    const finish = (reason: string): void => {
      if (ended) return;
      ended = true;
      if (ownerTimer) clearInterval(ownerTimer);
      chunks.close();
      this.sessionsById.delete(id);
      try {
        app?.cleanup(reason);
      } catch {
        // the lease may already be gone
      }
      this.log(`[mcp-host] session ${id} ended (${reason})`);
    };
    const live: Live = {
      info,
      sock,
      end: (reason) => {
        byeReason = reason;
        write({ knowns_mcp: PROXY_PROTOCOL, type: "bye", reason });
        finish(reason);
        sock.end();
        setTimeout(() => sock.destroy(), 2000).unref();
      },
    };
    this.sessionsById.set(id, live);
    this.log(
      `[mcp-host] session ${id} opened (client=${info.client || "?"}, pid=${hello.pid ?? 0})`,
    );

    if (hello.pid !== undefined) {
      const pid = hello.pid;
      ownerTimer = setInterval(() => {
        if (!isProcessAlive(pid)) live.end("owner_gone");
      }, this.opts.ownerCheckMs ?? 15_000);
      ownerTimer.unref();
    }

    // Frame splitter: control frames are answered here, everything else is raw MCP for serve().
    let pending: Buffer = Buffer.alloc(0);
    const feed = (data: Buffer): void => {
      pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
      for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, nl + 1);
        pending = pending.subarray(nl + 1);
        if (this.control(line, write)) continue;
        chunks.push(line);
      }
      if (pending.length > MAX_FRAME_BYTES) {
        write({
          knowns_mcp: PROXY_PROTOCOL,
          type: "error",
          code: "frame_too_large",
          message: "frame exceeds the limit",
          daemon_version: this.version,
        });
        finish("frame_too_large");
        sock.destroy();
      }
    };
    sock.on("data", feed);
    if (firstBytes.length > 0) feed(firstBytes);
    sock.once("end", () => chunks.close()); // half-close: drain, answer, then close
    sock.once("close", () => finish("connection closed"));

    void (async () => {
      try {
        app = await (this.opts.createApp ?? defaultCreateApp)(hello.project, hello.cwd, logger);
      } catch (e) {
        write({
          knowns_mcp: PROXY_PROTOCOL,
          type: "error",
          code: "internal",
          message: (e as Error).message,
          daemon_version: this.version,
        });
        finish("internal error");
        sock.end();
        return;
      }
      if (ended) {
        app.cleanup("session ended before start");
        return;
      }
      const hosted = app;
      let started = false;
      try {
        await hosted.server.serve(
          chunks,
          (text) => {
            if (!sock.destroyed && sock.writable) sock.write(text);
            // Like the stdio command: project detection starts after the first response.
            if (!started) {
              started = true;
              setImmediate(() => {
                void hosted.begin().then(() => {
                  info.project = hosted.state.getRoot();
                });
              });
            }
          },
          (msg) => logger.printf(msg),
        );
      } catch (e) {
        logger.printf(`session ${id}: ${(e as Error).message}`);
      }
      info.project = hosted.state.getRoot();
      if (byeReason === undefined) {
        finish("client closed");
        if (!sock.destroyed) sock.end();
      }
    })();
  }

  /** Handles a control frame; false when the line is MCP JSON-RPC. */
  private control(line: Buffer, write: (f: unknown) => void): boolean {
    // A control frame starts with {"knowns_mcp": ; anything else is JSON-RPC and is not parsed.
    const head = line.subarray(0, 40).toString("utf8");
    if (!/^\s*\{\s*"knowns_mcp"\s*:/.test(head)) return false;
    try {
      const f = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      if (f.type === "ping") write({ knowns_mcp: PROXY_PROTOCOL, type: "pong", n: f.n });
    } catch {
      // an unparsable control frame is ignored
    }
    return true;
  }

  private sessionLogger(id: string): McpLogger {
    const log = this.log;
    return { printf: (m: string) => log(`[mcp-host] ${id}: ${m}`) } as McpLogger;
  }
}

async function defaultCreateApp(project: string, cwd: string, log: McpLogger): Promise<HostedApp> {
  // Loaded when the first session arrives, so an idle daemon never pays for the MCP modules.
  const { newMcpApp } = await import("../mcp/index.ts");
  return newMcpApp(project, log, { cwd });
}
