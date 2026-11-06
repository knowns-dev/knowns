// internal/server/server.go: the HTTP server behind `knowns browser`. REST routes live in
// ./routes, SSE in ./sse.ts, the embedded UI in ./static.ts. Nothing here is imported until a
// command that serves HTTP runs, so `--version` startup is unaffected.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuntimeReadiness } from "../domain/readiness/index.ts";
import { partialOf } from "../domain/tasklifecycle/errors.ts";
import { responseToWire } from "../domain/tasklifecycle/wire.ts";
import type { Manager as LspManager } from "../lsp/manager.ts";
import type { Project } from "../models/config.ts";
import { Manager } from "../storage/core/manager.ts";
import type { Store } from "../storage/core/store.ts";
import { Registry } from "../storage/stores/registry.ts";
import { type App, type ServerOptions, storageFor } from "./app.ts";
import { AuthManager, authRoutes } from "./auth.ts";
import { applyCors, corsPreflight, trustedOrigin } from "./cors.ts";
import { goEncode } from "./gojson.ts";
import {
  type Ctx,
  errMessage,
  httpError,
  jsonResponse,
  makeCtx,
  notFound,
  Router,
  respondError,
  routingPath,
} from "./http.ts";
import { createLspManager, lspRuntimeStatuses, registerLsp } from "./lsp.ts";
import { registerConfig } from "./routes/config.ts";
import { registerDecisions } from "./routes/decisions.ts";
import { registerDocs } from "./routes/docs.ts";
import { registerEmbeddingModels, registerGraph } from "./routes/graph.ts";
import { registerImports } from "./routes/imports.ts";
import { registerMemories } from "./routes/memories.ts";
import {
  registerAudit,
  registerSearch,
  registerSkills,
  registerSmall,
  registerWorkspaces,
} from "./routes/misc.ts";
import { lifecycleService, registerTasks } from "./routes/tasks.ts";
import { registerTemplates, registerValidate } from "./routes/templates.ts";
import { registerTime } from "./routes/time.ts";
import { detectRuntimeServices, goDurationSeconds, registerRuntimeServices } from "./services.ts";
import { SSEBroker } from "./sse.ts";
import { serveUi } from "./static.ts";
import { registerTunnel, ServerTunnelManager } from "./tunnel.ts";

export type { ServerOptions };

const SERVICE_STATUS_INTERVAL_MS = 7000;
const TASK_SWEEP_INTERVAL_MS = 3_600_000;

interface ServiceStatusLike {
  name: string;
  type: string;
  status: string;
  pid?: number;
  port?: number;
  uptime?: number;
  enabledInConfig: boolean;
  details: Record<string, string>;
}

const serviceKey = (s: ServiceStatusLike): string =>
  s.details.language ? `${s.type}:${s.details.language}` : `${s.type}:${s.name}`;

function serviceJson(s: ServiceStatusLike): Record<string, unknown> {
  const keys = Object.keys(s.details).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const details: Record<string, string> = {};
  for (const k of keys) details[k] = s.details[k] as string;
  return {
    name: s.name,
    type: s.type,
    status: s.status,
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.port ? { port: s.port } : {}),
    ...(s.uptime ? { uptime: s.uptime } : {}),
    enabledInConfig: s.enabledInConfig,
    ...(keys.length > 0 ? { details } : {}),
  };
}

export class Server {
  readonly sse = new SSEBroker();
  readonly auth: AuthManager;
  readonly manager: Manager;
  readonly registry: Registry | undefined;
  readonly tunnel: ServerTunnelManager;
  private lspManager: LspManager | undefined;
  private readonly router = new Router();
  private bun: ReturnType<typeof Bun.serve> | undefined;
  private shutdownResolve: (() => void) | undefined;
  private readonly shutdownPromise = new Promise<void>((r) => {
    this.shutdownResolve = r;
  });
  private monitorTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private prevServices: ServiceStatusLike[] = [];
  private readonly app: App;

  constructor(
    private readonly store: Store | undefined,
    private readonly projectRoot: string,
    private readonly port: number,
    private readonly opts: ServerOptions = {},
  ) {
    this.auth = new AuthManager(opts.password ?? "");
    this.tunnel = new ServerTunnelManager(port);
    let registry: Registry | undefined;
    try {
      registry = new Registry();
      registry.load();
    } catch (e) {
      if (opts.dev) console.error(`warn: could not load project registry: ${errMessage(e)}`);
      registry = registry ?? undefined;
    }
    this.registry = registry;
    this.manager = new Manager(store, registry);

    if (store) {
      const storage = storageFor(store);
      let project: Project | undefined;
      try {
        project = storage.config.load();
      } catch {
        project = undefined;
      }
      if (project) this.lspManager = createLspManager(projectRoot, project, opts.dev === true);
      try {
        storage.workspaces.markAllStopped();
      } catch (e) {
        if (opts.dev) console.error(`warn: could not mark workspaces stopped: ${errMessage(e)}`);
      }
    }

    this.app = {
      sse: this.sse,
      auth: this.auth,
      manager: this.manager,
      registry: this.registry,
      opts,
      projectRoot,
      port,
      initialStore: store,
      storage: () => {
        const s = this.manager.getStore() ?? this.store;
        return s ? storageFor(s) : undefined;
      },
      need: () => {
        const s = this.manager.getStore();
        if (!s) throw new Error("no active project");
        return storageFor(s);
      },
    };
    this.buildRouter();
  }

  private activeStore(): Store | undefined {
    return this.manager.getStore() ?? this.store;
  }

  // ---- routing ------------------------------------------------------------------------------------

  private buildRouter(): void {
    const r = this.router;
    const app = this.app;
    authRoutes(r, this.auth, this.sse, () => {
      if (this.opts.tunnel) return false;
      return !this.tunnel.status().running;
    });
    r.get("/api/events", (c) => this.sse.subscribe(c.req.signal));
    r.post("/api/shutdown", () => {
      queueMicrotask(() => this.shutdownResolve?.());
      return jsonResponse(200, { status: "shutting down" });
    });
    r.get("/api/status", (c) => this.handleStatus(c));
    r.get("/api/runtime/ps", () => this.handleRuntimePs());
    r.post("/api/runtime/retry", (c) => this.handleRuntimeRetry(c));

    registerTasks(r, app);
    registerDocs(r, app);
    registerConfig(r, app);
    registerRuntimeServices(r, app, () => this.lspManager);
    registerTime(r, app);
    registerSearch(r, app);
    registerTemplates(r, app);
    registerValidate(r, app);
    registerImports(r, app);
    registerGraph(r, app);
    registerEmbeddingModels(r, app);
    registerMemories(r, app);
    registerDecisions(r, app);
    registerSmall(r, app);
    registerSkills(r, app);
    registerAudit(r);
    registerWorkspaces(r, app);
    if (this.lspManager) registerLsp(r, app, () => this.lspManager);
    registerTunnel(r, app, this.tunnel, () => this.auth.hasPassword());

    // The /api mount answers its own 404 for any method; everything else falls to the UI.
    r.fallback("/api/*", () => notFound());
    r.get("/*", (c) => serveUi(c.req, c.url.pathname));
  }

  /** The handler to install on a Bun listener. */
  fetchHandler(): (
    req: Request,
    srv: { requestIP(req: Request): { address: string } | null },
  ) => Promise<Response> {
    return (req, srv) => this.handle(req, srv.requestIP(req)?.address ?? "");
  }

  /** Start: bind 127.0.0.1:port and serve (Go: Server.Start). */
  async start(): Promise<void> {
    let bun: ReturnType<typeof Bun.serve>;
    try {
      bun = Bun.serve({
        port: this.port,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: this.fetchHandler(),
        error: () => httpError(500, "Internal Server Error"),
      });
    } catch (e) {
      const addr = `127.0.0.1:${this.port}`;
      const inUse = (e as { code?: string }).code === "EADDRINUSE";
      throw new Error(
        `failed to listen on ${addr}: listen tcp ${addr}: ${inUse ? "bind: address already in use" : errMessage(e)}`,
      );
    }
    await this.serve(bun);
  }

  /** The fetch handler: Recoverer, trusted origin, CORS, auth, then the router. */
  async handle(req: Request, remote = ""): Promise<Response> {
    try {
      const url = new URL(req.url);
      const rejected = trustedOrigin(
        req,
        () => this.auth.hasPassword(),
        this.opts.allowedOrigins ?? [],
      );
      if (rejected) return rejected;
      const pre = corsPreflight(req);
      if (pre) return pre;
      const finish = (res: Response): Response => {
        applyCors(req, res);
        return res;
      };
      const path = routingPath(url.pathname);
      const ctx0 = makeCtx(req, remote, {});
      const denied = this.auth.check(ctx0);
      if (denied) return finish(denied);
      const hit = this.router.resolve(req.method, path);
      if ("status" in hit) {
        if (hit.status === 405) {
          const res = new Response(null, { status: 405 });
          if (hit.allow.length > 0) res.headers.set("Allow", hit.allow.join(", "));
          return finish(res);
        }
        return finish(notFound());
      }
      const ctx = makeCtx(req, remote, hit.params);
      return finish(await hit.handler(ctx));
    } catch (e) {
      if (this.opts.dev) console.error("panic serving request:", e);
      return httpError(500, "Internal Server Error");
    }
  }

  // ---- handlers owned by the server itself -------------------------------------------------------

  private async handleStatus(_c: Ctx): Promise<Response> {
    const store = this.manager.getStore();
    const { inactivePayload, buildReadiness } = await import("../domain/readiness/index.ts");
    if (!store) return jsonResponse(200, inactivePayload());
    const storage = storageFor(store);
    const { buildSearchEnvironment } = await import("../domain/searchenv/index.ts");
    const { collectProjectRuntimeStatuses, lspStatusFromRuntime } = await import(
      "../lsp/project.ts"
    );
    let statuses = await lspRuntimeStatuses(this.app, this.lspManager, storage, true);
    if (!statuses) statuses = await collectProjectRuntimeStatuses(store.projectRoot);
    const payload = buildReadiness(storage, buildSearchEnvironment(), {
      lsp: statuses.map((s) => lspStatusFromRuntime(s) as never),
      runtime: loadRuntimeReadiness(process.env),
    });
    return jsonResponse(200, payload);
  }

  private async handleRuntimePs(): Promise<Response> {
    const q = await import("../runtime/queue.ts");
    let status: ReturnType<typeof q.loadStatus>;
    try {
      status = q.loadStatus();
    } catch (e) {
      return httpError(500, errMessage(e));
    }
    const projects: Record<string, unknown>[] = [];
    for (const p of status.projects) {
      let queue: ReturnType<typeof q.loadQueue>;
      try {
        queue = q.loadQueue(p.projectRoot);
      } catch {
        continue;
      }
      const running = queue.jobs.filter((j) => j.startedAt !== undefined && j.startedAt !== null);
      const queued = queue.jobs.filter((j) => j.startedAt === undefined || j.startedAt === null);
      const recent = queue.recent ?? [];
      projects.push({
        root: p.projectRoot,
        running: running.length > 0 ? running.map(q.jobJson) : null,
        queued: queued.length > 0 ? queued.map(q.jobJson) : null,
        recent: recent.length > 0 ? recent.map(q.resultJson) : null,
      });
    }
    return jsonResponse(200, { projects, status: q.statusJson(status) });
  }

  private async handleRuntimeRetry(c: Ctx): Promise<Response> {
    let req: { scope?: unknown; projectRoot?: unknown; jobs?: unknown };
    try {
      const v = await c.json();
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) throw new Error("bad type");
      req = (v ?? {}) as typeof req;
    } catch {
      return httpError(400, "invalid request body");
    }
    const q = await import("../runtime/queue.ts");
    interface Result {
      projectRoot: string;
      released: number;
      refused?: { jobId: string; error: string }[];
      error?: string;
    }
    const out = (results: Result[]): Response => jsonResponse(200, { results });
    switch (req.scope) {
      case "all": {
        let status: ReturnType<typeof q.loadStatus>;
        try {
          status = q.loadStatus();
        } catch (e) {
          return httpError(500, errMessage(e));
        }
        return out(
          status.projects.map((p) => {
            const r: Result = { projectRoot: p.projectRoot, released: 0 };
            try {
              r.released = q.retryDeadLetters(p.projectRoot).length;
            } catch (e) {
              r.error = errMessage(e);
            }
            return r;
          }),
        );
      }
      case "project": {
        const root = typeof req.projectRoot === "string" ? req.projectRoot : "";
        if (root.trim() === "")
          return httpError(400, 'projectRoot is required for scope "project"');
        const r: Result = { projectRoot: root, released: 0 };
        try {
          r.released = q.retryDeadLetters(root).length;
        } catch (e) {
          r.error = errMessage(e);
        }
        return out([r]);
      }
      case "jobs": {
        const jobs = Array.isArray(req.jobs)
          ? (req.jobs as { projectRoot?: string; jobId?: string }[])
          : [];
        if (jobs.length === 0) return httpError(400, 'jobs is required for scope "jobs"');
        const order: string[] = [];
        const byProject = new Map<string, string[]>();
        for (const ref of jobs) {
          if (!ref?.projectRoot?.trim() || !ref?.jobId?.trim()) {
            return httpError(400, "each job requires a projectRoot and a jobId");
          }
          if (!byProject.has(ref.projectRoot)) order.push(ref.projectRoot);
          byProject.set(ref.projectRoot, [...(byProject.get(ref.projectRoot) ?? []), ref.jobId]);
        }
        return out(
          order.map((root) => {
            const r: Result = { projectRoot: root, released: 0 };
            for (const jobId of byProject.get(root) ?? []) {
              try {
                q.retryJob(root, jobId);
                r.released++;
              } catch (e) {
                r.refused = [...(r.refused ?? []), { jobId, error: errMessage(e) }];
              }
            }
            return r;
          }),
        );
      }
      default:
        return httpError(400, 'scope must be one of "all", "project", "jobs"');
    }
  }

  // ---- background work -----------------------------------------------------------------------------

  private async snapshotServices(acquire: boolean): Promise<ServiceStatusLike[] | undefined> {
    const s = this.activeStore();
    if (!s) return undefined;
    try {
      return await detectRuntimeServices(this.app, this.lspManager, storageFor(s), acquire);
    } catch {
      return undefined;
    }
  }

  private startServiceMonitor(): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      const next = await this.snapshotServices(false);
      if (next && !this.stopped) {
        const prevBy = new Map(this.prevServices.map((s) => [serviceKey(s), s]));
        const now = new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
        const changes: Record<string, unknown>[] = [];
        for (const s of next) {
          const prev = prevBy.get(serviceKey(s));
          if (
            !prev ||
            (prev.status === s.status &&
              prev.pid === s.pid &&
              prev.port === s.port &&
              prev.enabledInConfig === s.enabledInConfig)
          ) {
            continue;
          }
          changes.push({
            name: s.name,
            type: s.type,
            previousStatus: prev.status,
            status: s.status,
            timestamp: now,
            service: serviceJson(s),
          });
        }
        this.prevServices = next;
        if (changes.length > 0) this.sse.broadcast({ type: "service:status", data: changes });
      }
      if (!this.stopped) {
        this.monitorTimer = setTimeout(tick, SERVICE_STATUS_INTERVAL_MS);
        this.monitorTimer.unref();
      }
    };
    void (async () => {
      const first = await this.snapshotServices(false);
      if (first) this.prevServices = first;
      if (this.stopped) return;
      this.monitorTimer = setTimeout(tick, SERVICE_STATUS_INTERVAL_MS);
      this.monitorTimer.unref();
    })();
  }

  /** StartTaskAutoArchiveSweeper: one bounded sweep at start, then hourly. */
  private startTaskSweeper(): void {
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      const s = this.activeStore();
      if (!s) return;
      const storage = storageFor(s);
      let result: unknown;
      let error = "";
      try {
        result = await lifecycleService(this.app, storage).autoArchive("auto-archive");
      } catch (e) {
        error = errMessage(e);
        result = partialOf(e);
      }
      if (result !== undefined && result !== null) {
        this.sse.broadcast({
          type: "tasks:lifecycle-sweep",
          data: { error, result: responseToWire(result as never) },
        });
      }
    };
    void run().finally(() => {
      if (this.stopped) return;
      this.sweepTimer = setInterval(() => void run(), TASK_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    });
  }

  private portFile(): string | undefined {
    return this.store ? join(this.store.root, ".server-port") : undefined;
  }

  private async releaseLspLease(): Promise<void> {
    const roots = new Set<string>();
    if (this.projectRoot) roots.add(this.projectRoot);
    const active = this.manager.getStore();
    if (active?.root) roots.add(active.projectRoot);
    const { newClient, disabledByEnv } = await import("../lspdaemon/index.ts");
    if (disabledByEnv()) return;
    for (const root of roots) {
      try {
        const signal = AbortSignal.timeout(2000);
        await newClient(root).tryReleaseLease(signal, "webui");
      } catch {
        // best effort
      }
    }
  }

  /**
   * Serve: install this server's handler on an already-bound Bun listener (the caller probed and
   * bound the port, which avoids the check-then-listen race), run until SIGINT/SIGTERM or
   * POST /api/shutdown, then clean up.
   */
  async serve(bun: ReturnType<typeof Bun.serve>): Promise<void> {
    if (this.opts.tunnel && !this.auth.hasPassword()) {
      throw new Error("tunnel requires password protection");
    }
    this.bun = bun;
    this.startTaskSweeper();
    const pf = this.portFile();
    if (pf) {
      try {
        mkdirSync(this.store?.root ?? "", { recursive: true });
        writeFileSync(pf, String(this.port), { mode: 0o644 });
      } catch (e) {
        process.stderr.write(`warn: could not write .server-port: ${errMessage(e)}\n`);
      }
    }
    this.startServiceMonitor();
    if (this.opts.tunnel) void this.autoStartTunnel();

    const onSignal = (): void => this.shutdownResolve?.();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    await this.shutdownPromise;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await this.shutdown();
  }

  private async autoStartTunnel(): Promise<void> {
    let url: string;
    try {
      url = await this.tunnel.start();
    } catch (e) {
      process.stderr.write(`  ✗  tunnel failed to start: ${errMessage(e)}\n`);
      return;
    }
    this.sse.broadcast({ type: "tunnel:status", data: this.tunnel.status() });
    console.log(`  ⇄  ${url}  (cloudflared)`);
    console.log();
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sse.closeAll();
    this.bun?.stop(true);
    const pf = this.portFile();
    if (pf) rmSync(pf, { force: true });
    const status = this.tunnel.status();
    if (status.running && status.startedByUs) await this.tunnel.stop().catch(() => undefined);
    if (this.lspManager) await this.lspManager.stopAll(undefined).catch(() => undefined);
    await this.releaseLspLease();
  }

  /** Requests a graceful stop (tests and the init --open path). */
  close(): void {
    this.shutdownResolve?.();
  }
}

void goEncode;
void goDurationSeconds;
void respondError;
