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
    const {
      executeRuntimeJob,
      persistSemanticRuntimeStatus,
      reloadSemanticRuntime,
      runtimeIndexEnqueuer,
      runtimeSeams,
    } = await import("../../runtime/executor.ts");
    // Reconcile and indexing run on worker threads so they never stall the sessions this daemon
    // hosts (spec D4). A test that installs its own watcher seam keeps the inline path.
    const { RunnerWorker, runnerWorkersEnabled } = await import("../../runtime/runner-worker.ts");
    const useWorkers = runnerWorkersEnabled() && runtimeSeams.watcherFactory === undefined;
    const jobWorker = useWorkers ? new RunnerWorker() : undefined;
    const watchWorker = useWorkers ? new RunnerWorker() : undefined;
    // startRuntimeWatcher: the project knowledge watcher for watch-enabled client leases.
    runtimeSeams.watcherFactory ??= watchWorker
      ? (signal, storeRoot) => watchWorker.watch(signal, storeRoot)
      : async (signal, storeRoot) => {
          const { startRuntimeWatcher } = await import("../../domain/reconcile/watcher.ts");
          await startRuntimeWatcher(storeRoot, {
            signal,
            index: runtimeIndexEnqueuer(storeRoot),
            onError: (err) =>
              process.stderr.write(`[runtime] watcher: ${(err as Error).message}\n`),
          });
        };
    const ac = new AbortController();
    const stop = () => ac.abort();
    // Whatever ends the process (a signal handler, an uncaught error, process.exit) writes out the
    // audit events still buffered; only a hard kill (SIGKILL, Windows TerminateProcess) can lose
    // the last ~25 ms.
    const auditMod = await import("../../storage/stores/audit-store.ts");
    const onExit = () => auditMod.flushAuditSync();
    process.on("exit", onExit);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The MCP session endpoint (KN-QS0B82): serves proxies for as long as the daemon runs. It never
    // blocks the daemon when it cannot listen. KNOWNS_MCP_PROXY=0 is a client-side opt-out only.
    const services = [...(runtimeSeams.services ?? [])];
    // An open MCP session keeps the daemon alive even when it holds no lease (no project).
    let sessionCount = (): number => 0;
    let hostRef: { retire(): void; start(): Promise<unknown> } | undefined;
    services.push(async (signal) => {
      const { McpHost } = await import("../../runtime/mcp-host.ts");
      const host = new McpHost();
      hostRef = host;
      sessionCount = () => host.sessions().length;
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
    await runDaemon(ac.signal, {
      executor: jobWorker
        ? async (storeRoot, job) => {
            try {
              await jobWorker.runJob(storeRoot, job);
            } finally {
              // The status file is the main thread's: the worker only did the job.
              try {
                persistSemanticRuntimeStatus();
              } catch {
                // best effort
              }
            }
          }
        : executeRuntimeJob,
      reloadHandler: (reload) => reloadSemanticRuntime(reload),
      ...(runtimeSeams.watcherFactory ? { watcherFactory: runtimeSeams.watcherFactory } : {}),
      services,
      busy: () => sessionCount() > 0,
      retire: () => hostRef?.retire(),
      reopen: async () => {
        await hostRef?.start();
      },
      ...(runtimeSeams.keepAlive ? { keepAlive: runtimeSeams.keepAlive } : {}),
    });
    await Promise.all([jobWorker?.stop(), watchWorker?.stop()]);
    // Audit events of the hosted sessions are written in batches; nothing may be left behind.
    await (await import("../../storage/stores/audit-store.ts")).flushAudit();
    process.off("exit", onExit);
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
