// `knowns mcp` (internal/cli/mcp.go): the MCP server over stdio. Everything heavy loads lazily so
// the process answers `initialize` within the D5 readiness budget.
import { defineCommand } from "../core/define.ts";
import { formatGoDuration, goQuote } from "../core/gofmt.ts";

export default defineCommand({
  use: "mcp",
  short: "Start the MCP (Model Context Protocol) server",
  long: `Start the Knowns MCP server, which exposes project management tools
to AI agents via the Model Context Protocol.

Use --stdio to communicate over stdin/stdout (default for MCP clients).`,
  silenceUsage: true,
  flags: [
    { type: "bool", name: "stdio", usage: "Use stdio transport (for MCP clients)", default: false },
    {
      type: "string",
      name: "project",
      usage: "Project root directory (auto-detected from cwd if not set)",
      default: "",
    },
  ],
  async run(ctx) {
    // Project root: --project flag > KNOWNS_PROJECT env > cwd walk-up.
    let projectRoot = ctx.flags.string("project");
    if (projectRoot === "") projectRoot = ctx.env.KNOWNS_PROJECT ?? "";

    const { newMcpApp, MCP_VERSION } = await import("../../mcp/index.ts");
    const app = newMcpApp(projectRoot);
    const log = app.state.log;
    const startedAt = Date.now();
    let started = false;
    const startOnce = (): void => {
      if (started) return;
      started = true;
      void app
        .begin()
        .then(() =>
          log.printf(
            `starting (version=${MCP_VERSION}, project=${goQuote(app.state.getRoot())}, pid=${process.pid})`,
          ),
        );
    };

    const onSignal = (name: string, text: string): void => {
      app.cleanup(`signal ${text}`);
      void name;
      process.exit(0);
    };
    const sigint = () => onSignal("SIGINT", "interrupt");
    const sigterm = () => onSignal("SIGTERM", "terminated");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);

    try {
      await app.server.serve(
        process.stdin,
        (text) => {
          ctx.print(text);
          setImmediate(startOnce);
        },
        (msg) => log.printf(msg),
      );
    } finally {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
    }
    const elapsedMs = Math.round(Date.now() - startedAt);
    log.printf(`stopped cleanly after ${formatGoDuration(elapsedMs * 1e6)}`);
    app.cleanup("serve returned");
  },
});
