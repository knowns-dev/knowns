// The daemon side of `knowns browser` (@task-KN-B3NWK3, spec D6, FR-8). The daemon listens on a
// control endpoint of its own, next to the MCP endpoint but separate from it; a browser launcher
// connects, sends one `listen` frame and the daemon binds an HTTP port and serves the existing web
// server on it. The control connection IS the listener's lease: when it closes (the launcher
// exits, is killed, or its owner pid dies) the daemon stops that listener and frees the port.
//
// Wire format, one JSON object per line, UTF-8:
//   client -> daemon  {"knowns_ui":1,"type":"listen","version","token","pid","port","storeRoot",
//                      "projectRoot","password","allowedOrigins":[],"dev","allowTaskHardDelete"}
//   daemon -> client  {"knowns_ui":1,"type":"listening","port":N}
//                  or {"knowns_ui":1,"type":"error","code","message"}   (then the daemon closes)
// D9: a listen frame with "mode":"detached" (and optional "idleMs") hands the listener to the
// daemon for good: the reply carries "reused":true when a detached listener of the same project
// already runs, and the connection is closed right after it. The listener lives while a tab holds
// an SSE connection and ends idleMs (default 30 min, KNOWNS_UI_IDLE_MS) after the last one leaves.
//   client -> daemon  {"knowns_ui":1,"type":"stop","version","token","port"?,"projectRoot"?}
//   daemon -> client  {"knowns_ui":1,"type":"stopped","ports":[N,...]}
//                  later {"knowns_ui":1,"type":"bye","reason":"shutdown"} just before closing
// Access control as for the MCP endpoint: the descriptor file (0600, in the 0700 `ui` directory)
// carries a random token that must be in the first frame, compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VERSION } from "../version.ts";
import { checkDescriptorLocation } from "./mcp-endpoint.ts";
import { goLogf, isProcessAlive, nowString, runtimeRoot } from "./queue.ts";

export const UI_PROTOCOL = 1;
const isWindows = process.platform === "win32";
const MAX_LINE_BYTES = 64 * 1024;
const FIRST_FRAME_MS = 5_000;
const OWNER_CHECK_MS = 2_000;
const MAX_UNAUTHENTICATED = 8;
const MAX_PORT_ATTEMPTS = 10;

export interface UiDescriptor {
  ui_protocol: number;
  version: string;
  kind: "unix_socket" | "windows_pipe";
  address: string;
  token: string;
  pid: number;
  started_at: string;
}

export interface UiListenRequest {
  port: number;
  storeRoot: string;
  projectRoot: string;
  password: string;
  allowedOrigins: string[];
  dev: boolean;
  allowTaskHardDelete: boolean;
  /** "lease" (default): the connection is the lease. "detached": the daemon owns the listener. */
  mode?: "lease" | "detached";
  /** Detached only: idle grace in ms after the last SSE client leaves. */
  idleMs?: number;
}

export const DEFAULT_UI_IDLE_MS = 30 * 60_000;

/** The idle grace: the request's, else KNOWNS_UI_IDLE_MS of the daemon, else 30 minutes. */
export function uiIdleMs(
  requested: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) return requested;
  const n = Number(env.KNOWNS_UI_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UI_IDLE_MS;
}

export interface UiListenerInfo {
  id: string;
  port: number;
  projectRoot: string;
  pid: number | undefined;
  startedAt: string;
  detached: boolean;
}

const versionToken = (v: string): string => v.replace(/[^A-Za-z0-9._+-]/g, "_");
const shortHash = (parts: string[], n: number): string =>
  createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, n);

export const uiDescriptorPath = (version: string = VERSION, root: string = runtimeRoot()): string =>
  join(root, "ui", `control-${versionToken(version)}.json`);

function address(
  version: string,
  root: string,
): { kind: UiDescriptor["kind"]; address: string; dir?: string } {
  if (isWindows) {
    return {
      kind: "windows_pipe",
      address: `\\\\.\\pipe\\knowns-ui-${shortHash([root.toLowerCase(), version], 16)}`,
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const dir = join(tmpdir(), `knowns-mcp-${uid}`);
  return {
    kind: "unix_socket",
    address: join(dir, `ui-${shortHash([root, version], 12)}.sock`),
    dir,
  };
}

/** Removes a socket nobody listens on; refuses when a live daemon holds it. */
async function freeSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  // Only a refused connection proves nobody listens; a timeout counts as alive.
  const alive = await new Promise<boolean>((done) => {
    const sock = net.connect({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      done(true);
    }, 1000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
  if (alive) throw new Error(`UI endpoint already active: ${path}`);
  rmSync(path, { force: true });
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user; refusing to listen there`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function readUiDescriptor(
  version: string = VERSION,
  root: string = runtimeRoot(),
): UiDescriptor | undefined {
  try {
    const d = JSON.parse(readFileSync(uiDescriptorPath(version, root), "utf8")) as UiDescriptor;
    return typeof d.address === "string" && typeof d.token === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

const frame = (o: Record<string, unknown>): string =>
  `${JSON.stringify({ knowns_ui: UI_PROTOCOL, ...o })}\n`;

interface Live {
  info: UiListenerInfo;
  /** Same project, password and capabilities: a second `knowns browser` may share it. */
  key: string;
  stop(reason: string): void;
  done: Promise<void>;
}

export interface UiHostOptions {
  version?: string;
  root?: string;
  logger?: (line: string) => void;
  /** Starts the web server on the bound listener; the real one wires Server.attach. */
  serve?: (
    req: UiListenRequest,
    bind: (fetch: import("../server/listen.ts").FetchHandler) => Promise<{
      bun: ReturnType<typeof Bun.serve>;
      port: number;
    }>,
  ) => Promise<{
    port: number;
    done: Promise<void>;
    stop(): void;
    /** Called with the number of connected SSE clients whenever it changes. */
    onClients?: (cb: (n: number) => void) => void;
  }>;
}

export class UiHost {
  private readonly version: string;
  private readonly root: string;
  private readonly live = new Map<string, Live>();
  private readonly pending = new Set<net.Socket>();
  private server: net.Server | undefined;
  private descriptor: UiDescriptor | undefined;
  private stopping = false;
  private seq = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: UiHostOptions = {}) {
    this.version = opts.version ?? VERSION;
    this.root = opts.root ?? runtimeRoot();
    this.log = opts.logger ?? goLogf;
  }

  listeners(): UiListenerInfo[] {
    return [...this.live.values()].map((l) => l.info);
  }

  get token(): string | undefined {
    return this.descriptor?.token;
  }

  async start(): Promise<UiDescriptor> {
    this.stopping = false;
    // A caller that names the root itself has made the choice, as for the MCP endpoint.
    if (this.opts.root === undefined) checkDescriptorLocation(this.root);
    const ep = address(this.version, this.root);
    if (ep.dir) {
      privateDir(ep.dir);
      await freeSocket(ep.address);
    }
    const server = net.createServer({ allowHalfOpen: false }, (sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: ep.address }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const descriptor: UiDescriptor = {
      ui_protocol: UI_PROTOCOL,
      version: this.version,
      kind: ep.kind,
      address: ep.address,
      token: randomBytes(32).toString("hex"),
      pid: process.pid,
      started_at: nowString(),
    };
    try {
      if (!isWindows) chmodSync(ep.address, 0o600);
      privateDir(join(this.root, "ui"));
      const path = uiDescriptorPath(this.version, this.root);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      // Never keep listening on an endpoint nobody can authenticate to, or one that is not private.
      server.close();
      if (descriptor.kind === "unix_socket") rmSync(descriptor.address, { force: true });
      throw e;
    }
    server.on("error", (e) => this.log(`[ui-host] listener error: ${e.message}`));
    this.server = server;
    this.descriptor = descriptor;
    return descriptor;
  }

  async stop(reason = "shutdown"): Promise<void> {
    this.stopping = true;
    const d = this.descriptor;
    for (const l of [...this.live.values()]) l.stop(reason);
    for (const s of this.pending) s.destroy();
    this.server?.close();
    this.server = undefined;
    if (d) {
      const cur = readUiDescriptor(d.version, this.root);
      if (!cur || cur.token === d.token) {
        rmSync(uiDescriptorPath(d.version, this.root), { force: true });
        if (d.kind === "unix_socket") rmSync(d.address, { force: true });
      }
    }
    this.descriptor = undefined;
    // Listeners release their ports asynchronously (Server.shutdown); wait for them.
    const deadline = Date.now() + 5000;
    while (this.live.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  }

  private onConnection(sock: net.Socket): void {
    if (this.stopping || this.pending.size >= MAX_UNAUTHENTICATED) {
      sock.destroy();
      return;
    }
    this.pending.add(sock);
    let buf = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => sock.destroy(), FIRST_FRAME_MS);
    const drop = (): void => {
      clearTimeout(timer);
      this.pending.delete(sock);
    };
    sock.on("error", () => undefined);
    sock.on("close", drop);
    sock.on("data", (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      if (buf.length > MAX_LINE_BYTES) {
        sock.destroy();
        return;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      handled = true;
      clearTimeout(timer);
      this.pending.delete(sock);
      void this.handleListen(sock, buf.subarray(0, nl).toString("utf8").replace(/\r$/, "")).catch(
        (e) => {
          sock.end(frame({ type: "error", code: "internal", message: (e as Error).message }));
        },
      );
    });
  }

  private async handleListen(sock: net.Socket, line: string): Promise<void> {
    const fail = (code: string, message: string): void => {
      sock.end(frame({ type: "error", code, message }));
    };
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return fail("bad_request", "unparsable frame");
    }
    const token = typeof m.token === "string" ? m.token : "";
    const want = this.descriptor?.token ?? "";
    const a = Buffer.from(token);
    const b = Buffer.from(want);
    if (want === "" || a.length !== b.length || !timingSafeEqual(a, b)) {
      return fail("unauthorized", "bad token");
    }
    if (m.knowns_ui !== UI_PROTOCOL || (m.type !== "listen" && m.type !== "stop"))
      return fail("bad_request", "expected listen or stop");
    if (m.version !== this.version) return fail("version_mismatch", `daemon is ${this.version}`);
    if (this.stopping) return fail("shutting_down", "daemon is exiting");
    if (m.type === "stop") return this.handleStop(sock, m);
    const str = (k: string): string => (typeof m[k] === "string" ? (m[k] as string) : "");
    const req: UiListenRequest = {
      port: Number.isInteger(m.port) ? (m.port as number) : 0,
      storeRoot: str("storeRoot"),
      projectRoot: str("projectRoot"),
      password: str("password"),
      allowedOrigins: Array.isArray(m.allowedOrigins)
        ? (m.allowedOrigins as unknown[]).filter((o): o is string => typeof o === "string")
        : [],
      dev: m.dev === true,
      allowTaskHardDelete: m.allowTaskHardDelete === true,
      mode: m.mode === "detached" ? "detached" : "lease",
      ...(typeof m.idleMs === "number" ? { idleMs: m.idleMs } : {}),
    };
    const detached = req.mode === "detached";
    const key = shortHash(
      [
        req.projectRoot,
        req.password,
        String(req.dev),
        String(req.allowTaskHardDelete),
        req.allowedOrigins.join(","),
      ],
      16,
    );
    if (detached) {
      for (const l of this.live.values()) {
        if (l.info.detached && l.key === key) {
          this.log(`[ui-host] ${l.info.id} reused on ${l.info.port}`);
          sock.end(frame({ type: "listening", port: l.info.port, id: l.info.id, reused: true }));
          return;
        }
      }
    }
    if (req.port < 1 || req.port > 65535) return fail("bad_request", "port out of range");
    const owner = Number.isInteger(m.pid) && (m.pid as number) > 0 ? (m.pid as number) : undefined;

    // The control connection is the lease: watch it from the start, so a client that gives up
    // (or a daemon that stops) while the server is still starting never leaves a listener behind.
    let sockGone = sock.destroyed;
    sock.on("close", () => {
      sockGone = true;
    });
    const serve = this.opts.serve ?? defaultServe;
    const { bindBrowserPort } = await import("../server/listen.ts");
    let handle: Awaited<ReturnType<typeof serve>>;
    try {
      handle = await serve(req, (fetchImpl) =>
        bindBrowserPort(req.port, MAX_PORT_ATTEMPTS, fetchImpl),
      );
    } catch (e) {
      return fail("internal", (e as Error).message);
    }
    const id = `u-${(++this.seq).toString(16).padStart(4, "0")}`;
    if (sockGone || this.stopping) {
      handle.stop();
      await handle.done.catch(() => undefined);
      this.log(`[ui-host] ${id} dropped before it was announced`);
      if (!sockGone)
        sock.end(frame({ type: "error", code: "shutting_down", message: "daemon is exiting" }));
      return;
    }
    const info: UiListenerInfo = {
      id,
      port: handle.port,
      projectRoot: req.projectRoot,
      pid: detached ? undefined : owner,
      startedAt: nowString(),
      detached,
    };
    let ended = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string): void => {
      if (ended) return;
      ended = true;
      clearInterval(poll);
      if (idleTimer) clearTimeout(idleTimer);
      if ((reason === "shutdown" || reason === "stopped") && !sock.destroyed) {
        sock.write(frame({ type: "bye", reason }));
      }
      handle.stop();
      sock.end();
    };
    if (detached) {
      // The daemon owns the listener: it lives while a tab is connected and ends after the grace.
      const grace = uiIdleMs(req.idleMs);
      const arm = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this.log(`[ui-host] ${id} idle for ${grace} ms`);
          stop("idle");
        }, grace);
        idleTimer.unref?.();
      };
      arm();
      handle.onClients?.((n) => {
        if (ended) return;
        if (n > 0) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
        } else arm();
      });
    }
    const poll = setInterval(() => {
      if (!detached && owner !== undefined && !isProcessAlive(owner)) {
        this.log(`[ui-host] ${id} owner ${owner} is gone`);
        stop("owner_gone");
      }
    }, OWNER_CHECK_MS);
    this.live.set(id, { info, key, stop, done: handle.done.catch(() => undefined) });
    if (!detached) sock.on("close", () => stop("closed"));
    // A listener that stopped on its own (POST /api/shutdown) tells the launcher so; one that failed
    // to clean up must not take the shared daemon down with an unhandled rejection.
    void handle.done
      .catch((e) => this.log(`[ui-host] ${id} shutdown error: ${(e as Error).message}`))
      .finally(() => {
        const byRequest = !ended;
        ended = true;
        clearInterval(poll);
        if (idleTimer) clearTimeout(idleTimer);
        this.live.delete(id);
        if (byRequest && sock.writable) sock.write(frame({ type: "bye", reason: "stopped" }));
        sock.end();
        setTimeout(() => sock.destroy(), 1000).unref();
        this.log(`[ui-host] ${id} on port ${info.port} stopped`);
      });
    this.log(`[ui-host] ${id} listening on ${info.port}`);
    if (detached) sock.end(frame({ type: "listening", port: handle.port, id }));
    else sock.write(frame({ type: "listening", port: handle.port, id }));
  }

  /** Stops the listeners on a port or of a project, and answers once their ports are free. */
  private async handleStop(sock: net.Socket, m: Record<string, unknown>): Promise<void> {
    const port = Number.isInteger(m.port) ? (m.port as number) : 0;
    const project = typeof m.projectRoot === "string" ? m.projectRoot : "";
    if (port === 0 && project === "") {
      sock.end(
        frame({ type: "error", code: "bad_request", message: "stop needs a port or a project" }),
      );
      return;
    }
    const hit = [...this.live.values()].filter(
      (l) =>
        (port !== 0 && l.info.port === port) || (project !== "" && l.info.projectRoot === project),
    );
    for (const l of hit) l.stop("stopped");
    await Promise.race([
      Promise.all(hit.map((l) => l.done)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    sock.end(frame({ type: "stopped", ports: hit.map((l) => l.info.port) }));
  }
}

/** The real server: the existing web server on a listener the daemon owns. */
const defaultServe: NonNullable<UiHostOptions["serve"]> = async (req, bind) => {
  await (await import("../wiring/index.ts")).installWiring();
  const { Store } = await import("../storage/core/index.ts");
  const { Server } = await import("../server/index.ts");
  const store = req.storeRoot !== "" ? new Store(req.storeRoot, req.projectRoot) : undefined;
  let resolveReady: (h: ReturnType<InstanceType<typeof Server>["fetchHandler"]>) => void = () => {};
  const ready = new Promise<ReturnType<InstanceType<typeof Server>["fetchHandler"]>>((r) => {
    resolveReady = r;
  });
  const bound = await bind(async (r, srv) => (await ready)(r, srv));
  let server: InstanceType<typeof Server>;
  try {
    server = new Server(store, req.projectRoot, bound.port, {
      dev: req.dev,
      allowedOrigins: req.allowedOrigins,
      tunnel: false,
      password: req.password,
      allowTaskHardDelete: req.allowTaskHardDelete,
    });
  } catch (e) {
    bound.bun.stop(true);
    throw e;
  }
  resolveReady(server.fetchHandler());
  const att = server.attach(bound.bun);
  return { port: bound.port, done: att.done, stop: att.stop, onClients: att.onClients };
};
