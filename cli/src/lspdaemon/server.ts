// Port of server.go: the project-scoped daemon that wraps one lsp.Manager and serves local clients.
import type net from "node:net";
import { join } from "node:path";
import { type Ctx, withTimeout } from "../lsp/context.ts";
import { errorAs, errorMessage } from "../lsp/errors.ts";
import { RuntimeError } from "../lsp/runtime-error.ts";
import type { LanguageRuntimeStatus, Session } from "../lsp/types.ts";
import { ensureToken, newState, writeState } from "./files.ts";
import {
  endpoint,
  ensureDir,
  type Handshake,
  identifyProject,
  type Paths,
  type ProjectIdentity,
  pathsForIdentity,
  validateHandshake,
} from "./identity.ts";
import {
  DaemonStateRunning,
  formatDeadline,
  idleTimeoutFromEnv,
  leaseTTLFromEnv,
  validateLeaseOwner,
} from "./lifecycle.ts";
import { type Request, type Response, runtimeErrorPayload, zeroLocation } from "./protocol.ts";
import { cleanupEndpoint, listenEndpoint, readJSON, writeJSON } from "./transport.ts";

/** The slice of lsp.Manager the daemon uses; the real Manager satisfies it structurally. */
export interface DaemonManager {
  withSession(ctx: Ctx, path: string, fn: (session: Session) => Promise<void>): Promise<void>;
  withAnyServer(ctx: Ctx, fn: (server: Session) => Promise<void>): Promise<void>;
  runtimeStatuses(ctx: Ctx): Promise<LanguageRuntimeStatus[]>;
  startLanguage(ctx: Ctx, langID: string): Promise<void>;
  stopLanguage(langID: string): Promise<void> | void;
  restartLanguage(ctx: Ctx, langID: string): Promise<void>;
  setConfig(cfg: unknown): void;
  describeRuntimeError(path: string, err: unknown): RuntimeError | null | undefined;
  stopAll(ctx: Ctx): Promise<void>;
}

export interface RunOptions {
  /** Milliseconds; 0 disables the idle exit. */
  idleTimeoutMs?: number;
  /** Replaces the project manager (tests). */
  manager?: DaemonManager;
  /** Replaces the config reload done by apply_config (tests). */
  reloadConfig?: () => void;
}

/** Run: serve until ctx aborts or the idle timeout fires. */
export function run(ctx: Ctx, root: string): Promise<void> {
  return runWithOptions(ctx, root, { idleTimeoutMs: idleTimeoutFromEnv() });
}

export async function runWithOptions(ctx: Ctx, root: string, opts: RunOptions): Promise<void> {
  const identity = identifyProject(root);
  const paths = pathsForIdentity(identity);
  ensureDir(paths);
  const token = ensureToken(paths);
  const manager = opts.manager ?? (await newProjectManager(identity.root));
  try {
    const listener = await listenEndpoint(paths);
    try {
      writeState(paths, newState(paths, process.pid));
      const server = new Server(identity, paths, token, manager, opts.idleTimeoutMs ?? 0);
      if (opts.reloadConfig) server.reloadConfigOverride = opts.reloadConfig;
      await server.serve(ctx, listener);
    } finally {
      listener.close();
      cleanupEndpoint(paths);
    }
  } finally {
    await manager.stopAll(undefined);
  }
}

interface Lease {
  owner: string;
  expiresAt: number;
}

export class Server {
  private active = 0;
  private lastActivity = 0;
  private leases = new Map<string, Lease>();
  private conns = new Set<net.Socket>();
  reloadConfigOverride: (() => void) | undefined;

  constructor(
    readonly identity: ProjectIdentity,
    readonly paths: Paths,
    readonly token: string,
    readonly manager: DaemonManager,
    readonly idleTimeoutMs: number,
  ) {}

  serve(ctx: Ctx, listener: net.Server): Promise<void> {
    this.markActivity();
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        ctx?.removeEventListener("abort", onAbort);
        resolve();
      };
      const closeAll = () => {
        listener.close();
        for (const c of this.conns) c.destroy();
        finish();
      };
      const onAbort = () => closeAll();
      listener.on("connection", (conn) => {
        void this.handle(conn);
      });
      listener.on("error", () => closeAll());
      listener.on("close", finish);
      let timer: ReturnType<typeof setInterval> | undefined;
      if (ctx?.aborted) return closeAll();
      ctx?.addEventListener("abort", onAbort, { once: true });
      if (this.idleTimeoutMs > 0) {
        let interval = this.idleTimeoutMs / 4;
        if (interval <= 0 || interval > 1000) interval = 1000;
        if (interval < 20) interval = 20;
        timer = setInterval(() => {
          if (this.shouldExitIdle(Date.now())) {
            process.stderr.write(
              `[knowns-lsp-daemon] idle timeout reached; exiting project=${this.identity.root} timeout=${this.idleTimeoutMs}ms\n`,
            );
            closeAll();
          }
        }, interval);
      }
    });
  }

  private async handle(conn: net.Socket): Promise<void> {
    this.markActivity();
    this.active++;
    this.conns.add(conn);
    conn.on("error", () => {});
    try {
      let req: Request;
      try {
        req = await readJSON<Request>(conn, { timeoutMs: 30_000 });
      } catch (e) {
        await writeJSON(conn, { error: errorMessage(e) }).catch(() => {});
        return;
      }
      const { ctx, cancel } = withTimeout(undefined, 30_000);
      try {
        const resp = await this.dispatch(ctx, req);
        await writeJSON(conn, resp).catch(() => {});
      } finally {
        cancel();
      }
    } finally {
      this.active--;
      this.markActivity();
      this.conns.delete(conn);
      // Ending a socket the peer already destroyed crashes Bun 1.3.12 when both ends share a process.
      if (!conn.destroyed && conn.writable) conn.end();
    }
  }

  async dispatch(ctx: Ctx, req: Request): Promise<Response> {
    const hs: Handshake = { project_root: req.project_root ?? "", token: req.token ?? "" };
    try {
      validateHandshake(this.identity, this.token, hs);
    } catch (e) {
      return { error: errorMessage(e) };
    }
    const path = req.path ?? "";
    const line = req.line ?? 0;
    const character = req.character ?? 0;
    const resp: Response = { location: zeroLocation };
    try {
      switch (req.operation) {
        case "ping":
          return {};
        case "definition":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.location = await s.definition(ctx, path, line, character);
          });
          break;
        case "references":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.locations = await s.references(ctx, path, line, character);
          });
          break;
        case "implementations":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.locations = await s.implementations(ctx, path, line, character);
          });
          break;
        case "diagnostics":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.diagnostics = await s.diagnostics(ctx, path);
          });
          break;
        case "document_symbols":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.document_symbols = await s.documentSymbols(ctx, path);
          });
          break;
        case "workspace_symbol":
          await this.manager.withAnyServer(ctx, async (s) => {
            resp.workspace_symbol_results = await s.workspaceSymbol(ctx, req.query ?? "");
          });
          break;
        case "rename":
          await this.manager.withSession(ctx, path, async (s) => {
            resp.workspace_edit = await s.rename(ctx, path, line, character, req.newName ?? "");
          });
          break;
        case "did_change":
          await this.manager.withSession(ctx, path, (s) => s.didChange(ctx, path, req.text ?? ""));
          break;
        case "status":
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "start_language":
          await this.manager.startLanguage(ctx, req.language ?? "");
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "stop_language":
          await this.manager.stopLanguage(req.language ?? "");
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "restart_language":
          await this.manager.restartLanguage(ctx, req.language ?? "");
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "apply_config":
          await this.reloadConfig();
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "lease_acquire":
          this.acquireLease(req.owner ?? "", req.ttlMillis ?? 0);
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        case "lease_release":
          this.releaseLease(req.owner ?? "");
          resp.statuses = await this.runtimeStatuses(ctx);
          break;
        default:
          throw new Error(`unsupported LSP daemon operation: ${req.operation}`);
      }
    } catch (err) {
      return this.errorResponse(path, err);
    }
    return resp;
  }

  private async reloadConfig(): Promise<void> {
    if (this.reloadConfigOverride) return this.reloadConfigOverride();
    const cfg = await loadProjectLspConfig(this.identity.root);
    this.manager.setConfig(cfg);
  }

  private async runtimeStatuses(ctx: Ctx): Promise<LanguageRuntimeStatus[]> {
    const [idleDeadline, owners] = this.lifecycleSnapshot(Date.now());
    const statuses = await this.manager.runtimeStatuses(ctx);
    const ep = endpoint(this.paths);
    for (const s of statuses) {
      s.owner = "daemon";
      s.daemon_state = DaemonStateRunning;
      s.daemon_pid = process.pid;
      s.daemon_clients = this.active;
      s.daemon_transport = ep.kind;
      s.daemon_endpoint = ep.address;
      const dl = formatDeadline(idleDeadline);
      if (dl !== "") s.daemon_idle_deadline = dl;
      else delete s.daemon_idle_deadline;
      if (owners.length > 0) {
        s.daemon_lease_count = owners.length;
        s.daemon_lease_owners = [...owners];
      } else {
        delete s.daemon_lease_count;
        delete s.daemon_lease_owners;
      }
    }
    return statuses;
  }

  private markActivity(): void {
    this.lastActivity = Date.now();
  }

  shouldExitIdle(now: number): boolean {
    if (this.idleTimeoutMs <= 0 || this.active > 0) return false;
    if (this.lifecycleSnapshot(now)[1].length > 0) return false;
    if (this.lastActivity === 0) return false;
    return now >= this.lastActivity + this.idleTimeoutMs;
  }

  private lifecycleSnapshot(now: number): [number, string[]] {
    const [owners, latestLease] = this.activeLeaseOwners(now);
    let deadline = 0;
    if (this.idleTimeoutMs > 0) {
      if (this.lastActivity !== 0) deadline = this.lastActivity + this.idleTimeoutMs;
      if (latestLease !== 0 && latestLease > deadline) deadline = latestLease;
    }
    return [deadline, owners];
  }

  private activeLeaseOwners(now: number): [string[], number] {
    const owners: string[] = [];
    let latest = 0;
    for (const [owner, lease] of [...this.leases]) {
      if (lease.expiresAt <= now) {
        this.leases.delete(owner);
        continue;
      }
      owners.push(owner);
      if (lease.expiresAt > latest) latest = lease.expiresAt;
    }
    owners.sort();
    return [owners, latest];
  }

  private acquireLease(ownerIn: string, ttlMillis: number): void {
    const owner = validateLeaseOwner(ownerIn);
    const ttl = ttlMillis > 0 ? ttlMillis : leaseTTLFromEnv();
    const expiresAt = Date.now() + ttl;
    this.leases.set(owner, { owner, expiresAt });
    process.stderr.write(
      `[knowns-lsp-daemon] lease acquired owner=${owner} ttl=${ttl}ms expires=${formatDeadline(expiresAt)}\n`,
    );
  }

  private releaseLease(ownerIn: string): void {
    const owner = validateLeaseOwner(ownerIn);
    this.leases.delete(owner);
    process.stderr.write(`[knowns-lsp-daemon] lease released owner=${owner}\n`);
  }

  private errorResponse(path: string, err: unknown): Response {
    const re = errorAs(err, RuntimeError);
    if (re) return { runtime_error: runtimeErrorPayload(re) };
    const described = this.manager.describeRuntimeError(path, err);
    if (described) return { runtime_error: runtimeErrorPayload(described) };
    return { error: errorMessage(err) };
  }
}

// ---- project manager construction (newProjectManager / projectStore) ----

/** The knowledge root of the project whose code lives at root, following a store link. */
async function projectKnowledgeRoot(root: string): Promise<string> {
  try {
    const { locateProjectAt } = await import("../storage/core/project-location.ts");
    return locateProjectAt(root).knowledgeRoot;
  } catch {
    return join(root, ".knowns");
  }
}

export async function loadProjectLspConfig(root: string) {
  const knowledgeRoot = await projectKnowledgeRoot(root);
  const { Store } = await import("../storage/core/store.ts");
  const { inStoresDir } = await import("../storage/core/project-location.ts");
  const { ConfigStore } = await import("../storage/stores/config-store.ts");
  const store = Store.open(knowledgeRoot);
  const project = new ConfigStore(
    store.root,
    inStoresDir(store.root) ? store.projectRoot : undefined,
  ).load();
  let defaults: { settings?: unknown } | undefined;
  try {
    const { EmbeddingSettingsStore } = await import(
      "../storage/stores/embedding-settings-store.ts"
    );
    defaults = new EmbeddingSettingsStore().load().projectDefaults;
  } catch {
    defaults = undefined;
  }
  const { Config } = await import("../lsp/config.ts");
  return Config.fromProject(project, defaults);
}

async function newProjectManager(root: string): Promise<DaemonManager> {
  const cfg = await loadProjectLspConfig(root);
  const { Manager } = await import("../lsp/manager.ts");
  const adapters = await import("../lsp/adapters/index.ts");
  const manager = new Manager(root, cfg);
  for (const adapter of adapters.all()) await manager.registerAdapter(adapter);
  manager.registerPluginAdapters({});
  return manager as unknown as DaemonManager;
}
