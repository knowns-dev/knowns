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
    services.push(async (signal) => {
      const { McpHost } = await import("../../runtime/mcp-host.ts");
      const host = new McpHost();
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
      executor: executeRuntimeJob,
      reloadHandler: (reload) => reloadSemanticRuntime(reload),
      ...(runtimeSeams.watcherFactory ? { watcherFactory: runtimeSeams.watcherFactory } : {}),
      services,
      busy: () => sessionCount() > 0,
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
