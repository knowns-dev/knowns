// The per-connection MCP session host of the runtime daemon (@task-KN-QS0B82). A proxy connects to
// the endpoint, says hello, and from then on the connection is a plain MCP stdio session served by
// its own McpServer + McpState, so project selection, client info, permissions, audit and the
// runtime lease never leak between sessions. Contract: "Daemon MCP endpoint: handshake contract"
// in @doc/specs/2026-11-16/mcp-thin-proxy.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type net from "node:net";
import { isAbsolute, resolve } from "node:path";
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
/** Before authentication nobody is trusted: a hello is a few hundred bytes. */
const MAX_HELLO_BYTES = 64 * 1024;
/** A control frame is tiny; longer lines are never parsed as one. */
const MAX_CONTROL_BYTES = 4096;
/** A client that stops reading is cut off past this much unsent output. */
const MAX_BUFFERED_WRITE = 64 << 20;
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
  // The daemon's own working directory means nothing to a client: a relative path is refused.
  if (!isAbsolute(cwd)) throw new HandshakeFailure("bad_hello", "hello.cwd must be absolute");
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
    project: ((p) => (p === "" || isAbsolute(p) ? p : resolve(cwd, p)))(str("project")),
    pid,
    client,
  };
}

/** Splits a byte stream into lines, looking at each chunk once (no re-scan of what is buffered). */
class LineSplitter {
  private parts: Buffer[] = [];
  private len = 0;
  constructor(private readonly maxLine: number) {}

  /** Complete lines (newline included) in this chunk, or "too_large" when a line exceeds the cap. */
  push(chunk: Buffer): Buffer[] | "too_large" {
    const out: Buffer[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl + 1);
      if (this.len + piece.length > this.maxLine) return "too_large";
      out.push(this.parts.length === 0 ? piece : Buffer.concat([...this.parts, piece]));
      this.parts = [];
      this.len = 0;
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      if (this.len + rest.length > this.maxLine) return "too_large";
      this.parts.push(rest);
      this.len += rest.length;
    }
    return out;
  }
}

/** A pull queue of byte chunks: serve() reads it as its stdin. */
class Chunks implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(chunk);
    this.wake();
  }

  /** Clean end of input: what is queued is still read. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  /** Abrupt end: what is queued is dropped. */
  abort(): void {
    this.queue = [];
    this.close();
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

/** Log text from a client: quoted, so a newline in a name cannot forge a log line. */
const logSafe = (s: string): string => JSON.stringify(s.slice(0, 80));

export class McpHost {
  private readonly version: string;
  private readonly root: string | undefined;
  private readonly sessionsById = new Map<string, Live>();
  private readonly pendingSockets = new Set<net.Socket>();
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
    this.stopping = false;
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
    for (const s of this.pendingSockets) s.destroy(); // clients that never said hello
    if (d) removeDescriptor(d, this.root);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    this.descriptor = undefined;
  }

  /**
   * Stops advertising and accepting (descriptor and socket removed) while the sessions already
   * connected carry on. A daemon that is about to exit calls this first, so a proxy that arrives
   * during the drain starts a new daemon instead of finding a descriptor nobody will serve.
   */
  retire(): void {
    const server = this.server;
    const d = this.descriptor;
    this.server = undefined;
    this.descriptor = undefined;
    for (const s of this.pendingSockets) s.destroy();
    if (d) removeDescriptor(d, this.root);
    server?.close(); // does not wait: established connections stay open
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
    this.pendingSockets.add(sock);
    let counted = true;
    const settleCount = (): void => {
      if (!counted) return;
      counted = false;
      this.unauthenticated--;
      this.pendingSockets.delete(sock);
    };
    sock.on("error", () => undefined); // a reset is a session end, not a daemon error
    sock.on("close", settleCount);

    // Before authentication the hello is capped far below a frame: nobody is trusted yet.
    const parts: Buffer[] = [];
    let len = 0;
    let done = false;
    const timer = setTimeout(
      () => fail(new HandshakeFailure("bad_hello", "no hello within the handshake window")),
      this.opts.helloTimeoutMs ?? 5000,
    );
    const fail = (f: HandshakeFailure, authed = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settleCount();
      sock.removeListener("data", onData);
      this.refuse(sock, f, authed);
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      const nl = chunk.indexOf(0x0a);
      const take = nl < 0 ? chunk.length : nl;
      len += take;
      if (len > MAX_HELLO_BYTES) {
        fail(new HandshakeFailure("frame_too_large", "hello frame too large"));
        return;
      }
      parts.push(nl < 0 ? chunk : chunk.subarray(0, nl));
      if (nl < 0) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      const line = Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
      const rest = chunk.subarray(nl + 1);
      done = false; // let fail() report errors below
      let hello: Hello;
      let authed = false;
      try {
        hello = parseHello(line);
        this.validate(hello, () => {
          authed = true;
        });
      } catch (e) {
        fail(
          e instanceof HandshakeFailure ? e : new HandshakeFailure("internal", String(e)),
          authed,
        );
        return;
      }
      done = true;
      settleCount();
      void this.open(sock, hello, rest);
    };
    sock.on("data", onData);
    sock.on("end", () => {
      if (!done) fail(new HandshakeFailure("bad_hello", "closed before hello"));
    });
  }

  private validate(h: Hello, authenticated: () => void): void {
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
    authenticated();
    if (h.version !== this.version) {
      throw new HandshakeFailure(
        "version_mismatch",
        `daemon is ${this.version}, client is ${h.version}`,
      );
    }
    if (this.sessionsById.size >= (this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
      throw new HandshakeFailure("busy", "session limit reached");
    }
  }

  /** The daemon's version is only told to a client that proved it holds the token. */
  private refuse(sock: net.Socket, f: HandshakeFailure, authed = false): void {
    const retry = RETRY_AFTER_MS[f.code];
    const frame = {
      knowns_mcp: PROXY_PROTOCOL,
      type: "error",
      code: f.code,
      message: f.message,
      ...(authed ? { daemon_version: this.version } : {}),
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

  private newSessionId(): string {
    for (;;) {
      const id = `s-${randomBytes(4).toString("hex")}`;
      if (!this.sessionsById.has(id)) return id;
    }
  }

  // --- sessions --------------------------------------------------------------------------------

  private async open(sock: net.Socket, hello: Hello, firstBytes: Buffer): Promise<void> {
    const id = this.newSessionId();
    const info: SessionInfo = {
      id,
      pid: hello.pid,
      client: (hello.client.name ?? "").slice(0, 80),
      project: "",
      startedAt: new Date().toISOString(),
    };
    const write = (frame: unknown): void => {
      if (sock.destroyed || !sock.writable) return;
      sock.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);
    };

    const logger = this.sessionLogger(id);
    const chunks = new Chunks();
    const abort = new AbortController();
    let app: HostedApp | undefined;
    let ended = false;
    let byeReason: string | undefined;
    let ownerTimer: ReturnType<typeof setInterval> | undefined;

    /** abrupt: queued and running work is dropped; a clean end lets started calls finish. */
    const finish = (reason: string, abrupt: boolean): void => {
      if (ended) return;
      ended = true;
      if (ownerTimer) clearInterval(ownerTimer);
      if (abrupt) {
        chunks.abort();
        abort.abort();
      } else chunks.close();
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
        finish(reason, true);
        sock.end();
        setTimeout(() => sock.destroy(), 2000).unref();
      },
    };

    // Input that arrives while the app loads is kept and served in order.
    const splitter = new LineSplitter(MAX_FRAME_BYTES);
    let overflow = false;
    const feed = (data: Buffer): void => {
      if (ended || overflow) return;
      const lines = splitter.push(data);
      if (lines === "too_large") {
        overflow = true;
        this.refuse(sock, new HandshakeFailure("frame_too_large", "frame exceeds the limit"), true);
        finish("frame_too_large", true);
        return;
      }
      for (const line of lines) {
        if (this.control(line, write, () => chunks.close())) continue;
        chunks.push(line);
      }
    };
    sock.on("data", feed);
    if (firstBytes.length > 0) feed(firstBytes);
    sock.once("end", () => {
      // half-close: drain, answer, then close
      if (!ended) chunks.close();
    });
    sock.once("close", () => finish("connection closed", true));

    // The app exists before the welcome, so a failure is an ordinary refusal.
    try {
      app = await (this.opts.createApp ?? defaultCreateApp)(hello.project, hello.cwd, logger);
    } catch (e) {
      sock.removeListener("data", feed);
      this.refuse(sock, new HandshakeFailure("internal", (e as Error).message), true);
      return;
    }
    if (ended || sock.destroyed) {
      app.cleanup("session ended before start");
      return;
    }
    this.sessionsById.set(id, live);
    write({
      knowns_mcp: PROXY_PROTOCOL,
      type: "welcome",
      version: this.version,
      session: id,
      daemon_pid: process.pid,
      max_frame_bytes: MAX_FRAME_BYTES,
    });
    this.log(
      `[mcp-host] session ${id} opened (client=${logSafe(info.client)}, pid=${hello.pid ?? 0})`,
    );

    if (hello.pid !== undefined) {
      const pid = hello.pid;
      ownerTimer = setInterval(() => {
        if (!isProcessAlive(pid)) live.end("owner_gone");
      }, this.opts.ownerCheckMs ?? 15_000);
      ownerTimer.unref();
    }

    const hosted = app;
    let started = false;
    try {
      await hosted.server.serve(
        chunks,
        (text) => {
          if (sock.destroyed || !sock.writable) return;
          sock.write(text);
          // A client that stops reading must not grow the daemon without bound.
          if (sock.writableLength > MAX_BUFFERED_WRITE) live.end("evicted");
          // Like the stdio command: project detection starts after the first response.
          if (!started) {
            started = true;
            setImmediate(() => {
              if (ended) return;
              void hosted.begin().then(() => {
                info.project = hosted.state.getRoot();
              });
            });
          }
        },
        (msg) => logger.printf(msg),
        abort.signal,
      );
    } catch (e) {
      logger.printf(`session ${id}: ${(e as Error).message}`);
    }
    info.project = hosted.state.getRoot();
    if (byeReason === undefined) {
      finish("client closed", false);
      if (!sock.destroyed) sock.end();
    }
  }

  /** Handles a control frame; false when the line is MCP JSON-RPC. */
  private control(line: Buffer, write: (f: unknown) => void, onClose: () => void): boolean {
    // A control frame is a small object with an integer knowns_mcp and no jsonrpc member; the
    // substring test keeps JSON-RPC lines from being parsed here at all.
    if (line.length > MAX_CONTROL_BYTES || !line.includes('"knowns_mcp"')) return false;
    let f: unknown;
    try {
      f = JSON.parse(line.toString("utf8"));
    } catch {
      return false;
    }
    if (!isObject(f) || !Number.isInteger(f.knowns_mcp) || "jsonrpc" in f) return false;
    if (f.type === "ping") write({ knowns_mcp: PROXY_PROTOCOL, type: "pong", n: f.n });
    // "close": no more requests will follow. Drain what was sent, answer it, then close. A TCP-style
    // half-close cannot carry this: Bun closes the whole socket when the peer shuts down writing.
    else if (f.type === "close") onClose();
    return true; // any other control type is ignored
  }

  private sessionLogger(id: string): McpLogger {
    const log = this.log;
    return { printf: (m: string) => log(`[mcp-host] ${id}: ${m}`) } as McpLogger;
  }
}

async function defaultCreateApp(project: string, cwd: string, log: McpLogger): Promise<HostedApp> {
  // Loaded when the first session arrives, so an idle daemon never pays for the MCP modules.
  const { newMcpApp } = await import("../mcp/index.ts");
  return newMcpApp(project, log, { cwd, daemonHosted: true });
}
