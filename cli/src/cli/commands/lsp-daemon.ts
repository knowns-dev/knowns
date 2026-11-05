// The hidden `__lsp-daemon` command group (internal/cli/lsp_daemon.go): the project LSP daemon
// the CLI, MCP and server start on first use.
import { defineCommand } from "../core/define.ts";

const run = defineCommand({
  use: "run",
  short: "Run the project LSP daemon",
  hidden: true,
  flags: [{ name: "project", type: "string", usage: "Project root directory" }],
  async run(ctx) {
    const project = ctx.flags.string("project");
    const root = project === "" ? process.cwd() : project;
    const { run: runDaemon } = await import("../../lspdaemon/server.ts");
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await runDaemon(ac.signal, root);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  },
});

export default defineCommand({
  use: "__lsp-daemon",
  short: "",
  hidden: true,
  subcommands: [run],
});
