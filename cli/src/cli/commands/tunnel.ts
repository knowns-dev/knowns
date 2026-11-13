// internal/cli/tunnel.go: `knowns tunnel status|stop`, the control surface for the cloudflared
// quick tunnel a `knowns browser --tunnel` server owns.
import { defineCommand } from "../core/define.ts";

const DEFAULT_PORT = 6420;

const portFlag = {
  type: "int",
  name: "port",
  usage: "Local port the tunnel targets",
  default: DEFAULT_PORT,
} as const;

const tunnelStatus = defineCommand({
  use: "status",
  short: "Show the current tunnel URL for a port",
  flags: [portFlag],
  async run(ctx) {
    const port = ctx.flags.int("port");
    const { Daemon } = await import("../../server/tunnel.ts");
    const d = new Daemon(port);
    let pid: number;
    try {
      pid = d.readPID();
    } catch {
      ctx.print(`no tunnel running for port ${port}\n`);
      return;
    }
    let url = "";
    try {
      url = d.publicURL();
    } catch {
      url = "";
    }
    ctx.print(`pid=${pid}\nport=${port}\nurl=${url}\n`);
  },
});

const tunnelStop = defineCommand({
  use: "stop",
  short: "Stop the cloudflared tunnel for a port",
  flags: [portFlag],
  async run(ctx) {
    const port = ctx.flags.int("port");
    const { Daemon } = await import("../../server/tunnel.ts");
    await new Daemon(port).stop();
    ctx.print(`tunnel stopped for port ${port}\n`);
  },
});

export default defineCommand({
  use: "tunnel",
  short: "Manage Cloudflare Quick Tunnels for the local server",
  subcommands: [tunnelStatus, tunnelStop],
});
