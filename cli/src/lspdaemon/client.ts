// Port of client.go: the client side (EnsureClient, daemon start/recovery) and the remote Session.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { type Ctx, ctxErr, sleep, withTimeout } from "../lsp/context.ts";
import { errorAs, errorIs, errorMessage } from "../lsp/errors.ts";
import { RuntimeError } from "../lsp/runtime-error.ts";
import type {
  Diagnostic,
  DocumentSymbol,
  LanguageRuntimeStatus,
  Location,
  Session,
  WorkspaceEdit,
  WorkspaceSymbolResult,
} from "../lsp/types.ts";
import { acquireProjectLock, ensureToken } from "./files.ts";
import {
  endpoint,
  ensureDir,
  identifyProject,
  type Paths,
  type ProjectIdentity,
  pathsForIdentity,
} from "./identity.ts";
import {
  DaemonError,
  disabledByEnv,
  ErrDisabledByEnv,
  leaseTTLFromEnv,
  validateLeaseOwner,
} from "./lifecycle.ts";
import type { Request, Response } from "./protocol.ts";
import { responseError } from "./protocol.ts";
import { dialEndpoint, EOFError, readJSON, TransportError, writeJSON } from "./transport.ts";

const defaultDialTimeoutMs = 2000;
const defaultStartTimeoutMs = 10_000;

/** Runtime: the daemon-backed counterpart of lsp.Manager used by MCP and the HTTP server. */
export class Runtime {
  private constructor(
    private readonly client: Client | undefined,
    private readonly err: unknown,
  ) {}

  static async create(ctx: Ctx, root: string): Promise<Runtime> {
    try {
      return new Runtime(await ensureClient(ctx, root), undefined);
    } catch (e) {
      return new Runtime(undefined, e);
    }
  }

  async withSession(
    _ctx: Ctx,
    _path: string,
    fn: (session: Session) => Promise<void>,
  ): Promise<void> {
    if (this.err) throw this.err;
    if (!this.client) throw new Error("LSP daemon client is not configured");
    await fn(new RemoteSession(this.client));
  }

  describeRuntimeError(_path: string, err: unknown): RuntimeError | undefined {
    return err instanceof RuntimeError ? err : (errorAs(err, RuntimeError) ?? undefined);
  }
}

/** NewRuntime */
export function newRuntime(ctx: Ctx, root: string): Promise<Runtime> {
  return Runtime.create(ctx, root);
}

export class Client {
  /** Test hook (Go: Client.recover). */
  recover: ((ctx: Ctx) => Promise<void>) | undefined;

  constructor(
    readonly identity: ProjectIdentity,
    readonly paths: Paths,
    readonly token: string,
  ) {}

  ping(ctx?: Ctx): Promise<void> {
    return this.callOnce(ctx, { operation: "ping" }).then(() => undefined);
  }

  private async statusCall(ctx: Ctx, req: Request): Promise<LanguageRuntimeStatus[]> {
    return (await this.call(ctx, req)).statuses ?? [];
  }

  runtimeStatuses(ctx?: Ctx): Promise<LanguageRuntimeStatus[]> {
    return this.statusCall(ctx, { operation: "status" });
  }
  startLanguage(ctx: Ctx, langID: string): Promise<LanguageRuntimeStatus[]> {
    return this.statusCall(ctx, { operation: "start_language", language: langID });
  }
  stopLanguage(ctx: Ctx, langID: string): Promise<LanguageRuntimeStatus[]> {
    return this.statusCall(ctx, { operation: "stop_language", language: langID });
  }
  restartLanguage(ctx: Ctx, langID: string): Promise<LanguageRuntimeStatus[]> {
    return this.statusCall(ctx, { operation: "restart_language", language: langID });
  }
  applyConfig(ctx?: Ctx): Promise<LanguageRuntimeStatus[]> {
    return this.statusCall(ctx, { operation: "apply_config" });
  }

  /** ttlMs <= 0 uses KNOWNS_LSP_DAEMON_LEASE_TTL (default 30m). */
  async acquireLease(ctx: Ctx, ownerIn: string, ttlMs = 0): Promise<LanguageRuntimeStatus[]> {
    const owner = validateLeaseOwner(ownerIn);
    const ttl = ttlMs > 0 ? ttlMs : leaseTTLFromEnv();
    return this.statusCall(ctx, { operation: "lease_acquire", owner, ttlMillis: Math.trunc(ttl) });
  }

  async releaseLease(ctx: Ctx, ownerIn: string): Promise<void> {
    const owner = validateLeaseOwner(ownerIn);
    await this.call(ctx, { operation: "lease_release", owner });
  }

  /** Releases a lease only when the daemon is already running; never starts one. */
  async tryReleaseLease(ctx: Ctx, ownerIn: string): Promise<void> {
    const owner = validateLeaseOwner(ownerIn);
    await this.callOnce(ctx, { operation: "lease_release", owner });
  }

  async call(ctx: Ctx, req: Request): Promise<Response> {
    let firstErr: unknown;
    try {
      return await this.callOnce(ctx, req);
    } catch (e) {
      firstErr = e;
    }
    const op = String(req.operation);
    if (!recoverableDaemonError(firstErr)) throw this.daemonError(op, firstErr);
    try {
      await this.recoverDaemon(ctx);
    } catch (recoverErr) {
      throw this.daemonError(`recover after ${op}`, new JoinedError([firstErr, recoverErr]));
    }
    try {
      return await this.callOnce(ctx, req);
    } catch (e) {
      throw this.daemonError(`retry ${op}`, e);
    }
  }

  async callOnce(ctx: Ctx, req: Request): Promise<Response> {
    const full: Request = { ...req, project_root: this.identity.root, token: this.token };
    const dial = withTimeout(ctx, defaultDialTimeoutMs);
    let sock: Awaited<ReturnType<typeof dialEndpoint>>;
    try {
      sock = await dialEndpoint(dial.ctx, endpoint(this.paths));
    } finally {
      dial.cancel();
    }
    const overall = withTimeout(ctx, 30_000);
    const onAbort = () => sock.destroy();
    overall.ctx.addEventListener("abort", onAbort, { once: true });
    try {
      // Register the reader before writing so an immediate reply is not lost.
      const reply = readJSON<Response>(sock);
      reply.catch(() => {});
      await writeJSON(sock, full);
      let resp: Response;
      try {
        resp = await reply;
      } catch (e) {
        const aborted = ctxErr(overall.ctx);
        if (aborted) throw new TransportError(aborted);
        throw e;
      }
      const err = responseError(resp);
      if (err) throw err;
      return resp;
    } finally {
      overall.cancel();
      sock.destroy();
    }
  }

  private recoverDaemon(ctx: Ctx): Promise<void> {
    if (this.recover) return this.recover(ctx);
    return this.startDaemon(ctx);
  }

  daemonError(operation: string, err: unknown): unknown {
    if (!err) return undefined;
    if (errorIs(err, ErrDisabledByEnv)) return err;
    return new DaemonError(operation, this.paths.logPath, this.paths.statePath, err);
  }

  async startDaemon(ctx: Ctx): Promise<void> {
    let lock: Awaited<ReturnType<typeof acquireProjectLock>>;
    try {
      lock = await acquireProjectLock(this.paths, {
        timeoutMs: defaultStartTimeoutMs,
        staleAgeMs: 30_000,
      });
    } catch (err) {
      try {
        await this.ping(ctx);
        return;
      } catch {
        throw err;
      }
    }
    try {
      try {
        await this.ping(ctx);
        return;
      } catch {
        // not running: start it
      }
      mkdirSync(dirname(this.paths.logPath), { recursive: true, mode: 0o700 });
      const logFd = openSync(this.paths.logPath, "a", 0o600);
      try {
        const { cmd, args } = await daemonStartCommand(this.identity.root);
        const child = spawn(cmd, args, {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
        child.on("error", () => {});
        child.unref();
      } catch (e) {
        throw new Error(`start LSP daemon: ${errorMessage(e)}`);
      } finally {
        closeSync(logFd);
      }
      await this.waitReady(ctx, defaultStartTimeoutMs);
    } finally {
      lock.release();
    }
  }

  private async waitReady(ctx: Ctx, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await this.ping(ctx);
        return;
      } catch (e) {
        lastErr = e;
      }
      await sleep(100, ctx);
    }
    if (lastErr) throw new Error(`timed out waiting for LSP daemon: ${errorMessage(lastErr)}`);
    throw new Error("timed out waiting for LSP daemon");
  }
}

class JoinedError extends Error {
  override readonly cause: unknown;
  constructor(readonly errors: unknown[]) {
    super(errors.map(errorMessage).join("\n"));
    this.cause = errors[0];
  }
}

/** The argv that re-runs this program with `__lsp-daemon run`, built on the `__runtime` mechanism. */
export async function daemonStartCommand(root: string): Promise<{ cmd: string; args: string[] }> {
  const { daemonCommand } = await import("../runtime/queue.ts");
  const { cmd, args } = daemonCommand();
  const base = args.slice(0, Math.max(0, args.length - 2));
  return { cmd, args: [...base, "__lsp-daemon", "run", "--project", root] };
}

export function recoverableDaemonError(err: unknown): boolean {
  if (!err) return false;
  for (let cur: unknown = err, depth = 0; cur && depth < 16; depth++) {
    if (cur instanceof TransportError || cur instanceof EOFError) return true;
    const code = (cur as { code?: string }).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("connection refused") ||
    msg.includes("connection reset") ||
    msg.includes("broken pipe")
  );
}

/** NewClient: identity, paths and token for root (creates the daemon dir and token). */
export function newClient(root: string): Client {
  const identity = identifyProject(root);
  const paths = pathsForIdentity(identity);
  ensureDir(paths);
  const token = ensureToken(paths);
  return new Client(identity, paths, token);
}

/** EnsureClient: a client with a live daemon behind it (starting one when needed). */
export async function ensureClient(ctx: Ctx, root: string): Promise<Client> {
  if (disabledByEnv()) throw ErrDisabledByEnv;
  const client = newClient(root);
  try {
    await client.ping(ctx);
    return client;
  } catch {
    // start below
  }
  try {
    await client.startDaemon(ctx);
  } catch (e) {
    throw client.daemonError("start", e);
  }
  return client;
}

export class RemoteSession implements Session {
  constructor(private readonly client: Client) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async waitReady(): Promise<void> {}
  alive(): boolean {
    return true;
  }
  async withFile(_ctx: Ctx, _path: string, fn: () => Promise<void>): Promise<void> {
    await fn();
  }
  async didChange(ctx: Ctx, path: string, text: string): Promise<void> {
    await this.client.call(ctx, { operation: "did_change", path, text });
  }
  async definition(ctx: Ctx, path: string, line: number, col: number): Promise<Location> {
    const r = await this.client.call(ctx, { operation: "definition", path, line, character: col });
    return r.location as Location;
  }
  async references(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]> {
    const r = await this.client.call(ctx, { operation: "references", path, line, character: col });
    return r.locations ?? [];
  }
  async implementations(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]> {
    const r = await this.client.call(ctx, {
      operation: "implementations",
      path,
      line,
      character: col,
    });
    return r.locations ?? [];
  }
  async diagnostics(ctx: Ctx, path: string): Promise<Diagnostic[]> {
    return (await this.client.call(ctx, { operation: "diagnostics", path })).diagnostics ?? [];
  }
  async documentSymbols(ctx: Ctx, path: string): Promise<DocumentSymbol[]> {
    return (
      (await this.client.call(ctx, { operation: "document_symbols", path })).document_symbols ?? []
    );
  }
  async workspaceSymbol(ctx: Ctx, query: string): Promise<WorkspaceSymbolResult[]> {
    return (
      (await this.client.call(ctx, { operation: "workspace_symbol", query }))
        .workspace_symbol_results ?? []
    );
  }
  async rename(
    ctx: Ctx,
    path: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<WorkspaceEdit> {
    const r = await this.client.call(ctx, {
      operation: "rename",
      path,
      line,
      character: col,
      newName,
    });
    return r.workspace_edit ?? { changes: null, documentChanges: null };
  }
}
