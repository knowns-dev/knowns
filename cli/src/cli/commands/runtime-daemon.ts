// The hidden `__runtime` command group (internal/cli/runtime.go runtimeInternalCmd): the shared
// runtime daemon the CLI, MCP and server spawn on first use, and its raw status.
import { defineCommand } from "../core/define.ts";

const run = defineCommand({
  use: "run",
  short: "Run the internal shared runtime",
  hidden: true,
  async run() {
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
    await runDaemon(ac.signal, {
      executor: executeRuntimeJob,
      reloadHandler: (reload) => reloadSemanticRuntime(reload),
      ...(runtimeSeams.watcherFactory ? { watcherFactory: runtimeSeams.watcherFactory } : {}),
      ...(runtimeSeams.services ? { services: runtimeSeams.services } : {}),
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
