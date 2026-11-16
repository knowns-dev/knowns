// The hidden `__runtime` command group (internal/cli/runtime.go runtimeInternalCmd): the shared
// runtime daemon the CLI, MCP and server spawn on first use, and its raw status.
import { defineCommand } from "../core/define.ts";

const run = defineCommand({
  use: "run",
  short: "Run the internal shared runtime",
  hidden: true,
  async run() {
    (await import("../../runtime/priority.ts")).lowerProcessPriority();
    const { runDaemon } = await import("../../runtime/queue.ts");
    const { executeRuntimeJob, reloadSemanticRuntime, runtimeIndexEnqueuer, runtimeSeams } =
      await import("../../runtime/executor.ts");
    // startRuntimeWatcher: the project knowledge watcher for watch-enabled client leases.
    runtimeSeams.watcherFactory ??= async (signal, storeRoot) => {
      const { startRuntimeWatcher } = await import("../../domain/reconcile/watcher.ts");
      await startRuntimeWatcher(storeRoot, {
        signal,
        index: runtimeIndexEnqueuer(storeRoot),
        onError: (err) => process.stderr.write(`[runtime] watcher: ${(err as Error).message}\n`),
      });
    };
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The MCP session endpoint (KN-QS0B82): serves proxies for as long as the daemon runs. It never
    // blocks the daemon when it cannot listen. KNOWNS_MCP_PROXY=0 is a client-side opt-out only.
    const services = [...(runtimeSeams.services ?? [])];
    // An open MCP session keeps the daemon alive even when it holds no lease (no project).
    let sessionCount = (): number => 0;
    let uiListenerCount = (): number => 0;
    let mcpSessions: () => import("../../runtime/mcp-host.ts").SessionInfo[] = () => [];
    let uiListeners: () => import("../../runtime/ui-host.ts").UiListenerInfo[] = () => [];
    let poolUsage: () => import("../../runtime/live-report.ts").PoolUsage | undefined = () =>
      undefined;
    services.push(async (signal) => {
      const { McpHost } = await import("../../runtime/mcp-host.ts");
      const host = new McpHost();
      sessionCount = () => host.sessions().length;
      mcpSessions = () => host.sessions();
      // The worker pool of the MCP host (KN-SR962X) reports its usage here once it exists.
      poolUsage = () => (host as { poolUsage?: () => never }).poolUsage?.();
      try {
        await host.start();
      } catch (err) {
        process.stderr.write(`[runtime] mcp endpoint unavailable: ${(err as Error).message}\n`);
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await host.stop("shutdown");
    });
    // The web UI host (KN-B3NWK3): `knowns browser` asks the daemon to listen; an open UI keeps it up.
    services.push(async (signal) => {
      const { UiHost } = await import("../../runtime/ui-host.ts");
      const host = new UiHost();
      uiListenerCount = () => host.listeners().length;
      uiListeners = () => host.listeners();
      try {
        await host.start();
      } catch (err) {
        process.stderr.write(`[runtime] ui endpoint unavailable: ${(err as Error).message}\n`);
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await host.stop("shutdown");
    });
    // What `runtime status/ps` and `doctor` show (KN-A1Q129): sessions, UI listeners, pool usage.
    services.push(async (signal) => {
      const lr = await import("../../runtime/live-report.ts");
      let last = "";
      let lastWrite = 0;
      const publish = (): void => {
        const live = lr.liveReportNow(
          mcpSessions().map((x) => ({
            id: x.id,
            client: x.client,
            project: x.project,
            startedAt: x.startedAt,
            ...(x.pid !== undefined ? { pid: x.pid } : {}),
          })),
          uiListeners().map((x) => ({
            id: x.id,
            port: x.port,
            projectRoot: x.projectRoot,
            startedAt: x.startedAt,
            ...(x.pid !== undefined ? { pid: x.pid } : {}),
          })),
          poolUsage(),
        );
        const key = JSON.stringify({ ...live, updatedAt: "" });
        if (key === last && Date.now() - lastWrite < 30_000) return;
        try {
          lr.writeLiveReport(live);
          last = key;
          lastWrite = Date.now();
        } catch {
          // diagnostics only
        }
      };
      publish();
      const timer = setInterval(publish, 2000);
      timer.unref();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      clearInterval(timer);
      lr.removeLiveReport();
    });
    await runDaemon(ac.signal, {
      executor: executeRuntimeJob,
      reloadHandler: (reload) => reloadSemanticRuntime(reload),
      ...(runtimeSeams.watcherFactory ? { watcherFactory: runtimeSeams.watcherFactory } : {}),
      services,
      busy: () => sessionCount() > 0 || uiListenerCount() > 0,
      ...(runtimeSeams.keepAlive ? { keepAlive: runtimeSeams.keepAlive } : {}),
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  },
});

const status = defineCommand({
  use: "status",
  short: "Show shared runtime daemon status",
  hidden: true,
  async run(ctx) {
    const q = await import("../../runtime/queue.ts");
    const s = q.loadStatus();
    if (ctx.json || ctx.plain) {
      ctx.printJSON(q.statusJson(s));
      return;
    }
    ctx.print(`Runtime running: ${s.running}\n`);
    ctx.print(`PID: ${s.pid ?? 0}\n`);
    ctx.print(`Clients: ${s.clients.length}\n`);
    ctx.print(`Projects: ${s.projects.length}\n`);
  },
});

export default defineCommand({
  use: "__runtime",
  short: "Internal shared runtime",
  hidden: true,
  subcommands: [run, status],
});
