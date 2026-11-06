// internal/cli/browser.go: `knowns browser`, the web UI server. The server module (and Bun.serve)
// load only when the command runs.
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { VERSION } from "../../version.ts";
import type { CommandContext } from "../core/define.ts";
import { defineCommand } from "../core/define.ts";
import { SilentExit } from "../core/exit.ts";
import { getStoreErr } from "../core/helpers.ts";
import { StyleBold, StyleDim, StyleInfo, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";

export const DEFAULT_BROWSER_PORT = 6420;
const MAX_BROWSER_PORT_ATTEMPTS = 10;

type Store = import("../../storage/core/store.ts").Store;

/** resolveProject: --project, then --scan, then the cwd project, else picker mode. */
async function resolveProject(
  ctx: CommandContext,
): Promise<{ store: Store | undefined; projectRoot: string }> {
  const { Store, locateProjectAt, locationWarnings } = await import("../../storage/core/index.ts");
  const projectFlag = ctx.flags.string("project");
  const scanFlag = ctx.flags.string("scan");

  if (projectFlag !== "") {
    try {
      const loc = locateProjectAt(projectFlag);
      for (const msg of locationWarnings(loc)) ctx.printErr(`Warning: ${msg}\n`);
      return { store: new Store(loc.knowledgeRoot, loc.projectRoot), projectRoot: loc.projectRoot };
    } catch {
      // Not a project yet: open the path so the browser can offer to initialize it.
      const abs = resolve(ctx.cwd, projectFlag);
      return { store: Store.open(join(abs, ".knowns")), projectRoot: abs };
    }
  }

  if (scanFlag !== "") {
    const dirs = scanFlag.split(",").map((d) => d.trim());
    try {
      const { Registry } = await import("../../storage/stores/registry.ts");
      const reg = new Registry();
      reg.load();
      const added = reg.scan(dirs);
      if (added.length > 0) {
        ctx.print(`  ${StyleInfo.render("⊕")}  Discovered ${added.length} project(s)\n`);
      }
    } catch {
      // ignored, as in Go
    }
  }

  try {
    const store = await getStoreErr(ctx.cmd);
    return { store, projectRoot: store.projectRoot };
  } catch {
    return { store: undefined, projectRoot: "" };
  }
}

function dial(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveDial) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolveDial(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** bindBrowserPort: skip ports something already answers on, then bind the first free one. */
async function bindBrowserPort(
  startPort: number,
  attempts: number,
  fetchImpl: (
    req: Request,
    srv: { requestIP(req: Request): { address: string } | null },
  ) => Promise<Response>,
): Promise<{ bun: ReturnType<typeof Bun.serve>; port: number }> {
  for (let offset = 0; offset < attempts; offset++) {
    const port = startPort + offset;
    if (await dial("127.0.0.1", port, 200)) continue;
    try {
      const bun = Bun.serve({
        port,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: fetchImpl,
        error: () => new Response("Internal Server Error\n", { status: 500 }),
      });
      return { bun, port };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      if (code === "EADDRINUSE" || msg.includes("in use") || msg.includes("address already"))
        continue;
      throw new Error(`check port ${port}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`no available port in range ${startPort}-${startPort + attempts - 1}`);
}

async function waitForHTTPServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dial("127.0.0.1", port, 200)) return true;
    await sleep(100);
  }
  return false;
}

/** stopExistingServer: POST /api/shutdown, then wait (up to ~3s) for the port to free up. */
async function stopExistingServer(ctx: CommandContext, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    await res.arrayBuffer().catch(() => undefined);
  } catch {
    ctx.print(`${StyleDim.render("No existing server found.")}\n`);
    return false;
  }
  ctx.print(`${StyleWarning.render("Existing server detected.")} Waiting for shutdown...\n`);
  for (let i = 0; i < 10; i++) {
    if (!(await dial("localhost", port, 200))) {
      ctx.print(`${StyleSuccess.render("Previous server stopped.")}\n`);
      return true;
    }
    await sleep(300);
  }
  ctx.print(`${StyleWarning.render("Timed out waiting for previous server to stop.")}\n`);
  return false;
}

/** openBrowser: best effort, detached. */
export function openBrowser(url: string): void {
  let cmd: string[] | undefined;
  switch (process.platform) {
    case "darwin":
      cmd = ["open", url];
      break;
    case "linux":
      cmd = ["xdg-open", url];
      break;
    case "win32":
      cmd = ["cmd", "/c", "start", url];
      break;
  }
  if (!cmd) return;
  try {
    Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    // Go ignores cmd.Start errors
  }
}

/** init --open: NewServer(store, cwd, port, Options{}).Start() on the configured port (default 3001). */
export async function openProjectBrowser(ctx: CommandContext, cwd: string): Promise<void> {
  const { installWiring } = await import("../../wiring/index.ts");
  await installWiring();
  const { Store } = await import("../../storage/core/index.ts");
  const { createStorage } = await import("../../storage/adapters.ts");
  const store = Store.open(join(cwd, ".knowns"));
  let port = 3001;
  try {
    const p = createStorage(store).config.load().settings.serverPort;
    if (p) port = p;
  } catch {
    // keep the default
  }
  const url = `http://localhost:${port}`;
  setTimeout(() => openBrowser(url), 0);
  const { Server } = await import("../../server/index.ts");
  const server = new Server(store, cwd, port, {});
  ctx.print(`  ${StyleInfo.render("→")}  ${StyleBold.render(url)}\n\n`);
  await server.start();
}

export default defineCommand({
  use: "browser",
  short: "Launch the Knowns web UI",
  long: "Start the Knowns HTTP server and optionally open it in a browser.\nCan be launched outside a repo to use the workspace picker.",
  args: undefined,
  flags: [
    {
      type: "int",
      name: "port",
      usage: "HTTP server port (default: 6420; tries next ports if busy)",
      default: 0,
    },
    { type: "bool", name: "open", usage: "Open browser after starting", default: false },
    { type: "bool", name: "no-open", usage: "Don't automatically open browser", default: false },
    {
      type: "bool",
      name: "restart",
      usage: "Restart server if already running",
      default: false,
    },
    {
      type: "bool",
      name: "dev",
      usage: "Enable development mode (verbose logging)",
      default: false,
    },
    { type: "string", name: "project", usage: "Project path to open directly", default: "" },
    {
      type: "string",
      name: "scan",
      usage: "Comma-separated directories to scan for projects",
      default: "",
    },
    {
      type: "bool",
      name: "watch",
      usage: "No effect; code files are no longer indexed",
      default: false,
      hidden: true,
    },
    {
      type: "bool",
      name: "tunnel",
      usage: "Expose via a Cloudflare Quick Tunnel (requires cloudflared)",
      default: false,
    },
    {
      type: "string",
      name: "password",
      usage: "Protect WebUI with a password (in-memory only)",
      default: "",
    },
    {
      type: "bool",
      name: "allow-task-hard-delete",
      usage: "Grant this server instance Task hard-delete capability",
      default: false,
    },
  ],
  async run(ctx) {
    let port = ctx.flags.int("port");
    const openFlag = ctx.flags.bool("open");
    const noOpen = ctx.flags.bool("no-open");
    const restart = ctx.flags.bool("restart");
    const dev = ctx.flags.bool("dev");
    const tunnelFlag = ctx.flags.bool("tunnel");
    const passwordFlag = ctx.flags.string("password");
    const allowTaskHardDelete = ctx.flags.bool("allow-task-hard-delete");
    if (tunnelFlag && passwordFlag.trim() === "") {
      throw new Error("--tunnel requires --password to protect the public server");
    }

    const { installWiring } = await import("../../wiring/index.ts");
    await installWiring();

    const { store, projectRoot } = await resolveProject(ctx);
    if (port === 0) port = DEFAULT_BROWSER_PORT;

    if (store) {
      try {
        const { Registry } = await import("../../storage/stores/registry.ts");
        const reg = new Registry();
        reg.load();
        const p = reg.add(projectRoot);
        reg.setActive(p.id);
      } catch {
        // best effort, as in Go
      }
    }

    if (restart) {
      ctx.print(
        `${StyleWarning.render("↻")} Attempting to stop existing server on port ${port}...\n`,
      );
      await stopExistingServer(ctx, port);
    }

    const { Server } = await import("../../server/index.ts");
    // The listener is bound before the Server exists (probe, then bind, like Go's pre-bound
    // listener); requests wait for the handler, which is ready one tick later.
    let resolveReady: (h: ReturnType<InstanceType<typeof Server>["fetchHandler"]>) => void =
      () => {};
    const ready = new Promise<ReturnType<InstanceType<typeof Server>["fetchHandler"]>>((r) => {
      resolveReady = r;
    });
    let bound: Awaited<ReturnType<typeof bindBrowserPort>>;
    try {
      bound = await bindBrowserPort(port, MAX_BROWSER_PORT_ATTEMPTS, async (req, srv) =>
        (await ready)(req, srv),
      );
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (bound.port !== port) {
      ctx.print(
        `  ${StyleWarning.render("↷")}  Port ${port} is busy, using ${bound.port} instead\n`,
      );
    }
    port = bound.port;

    const shouldOpen = openFlag && !noOpen;
    // Exact origins trusted on top of the server's own (the Vite dev UI on another port). Not in
    // 0.34.1, which trusted every loopback port (D12, TSR-X86JV4).
    const allowedOrigins = (ctx.env.KNOWNS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== "")
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return "";
        }
      })
      .filter((o) => o !== "" && o !== "null");
    const server = new Server(store, projectRoot, port, {
      dev,
      allowedOrigins,
      tunnel: tunnelFlag,
      password: passwordFlag,
      allowTaskHardDelete,
    });
    resolveReady(server.fetchHandler());

    const url = `http://localhost:${port}`;
    ctx.print("\n");
    ctx.print(
      `  ${StyleSuccess.render("●")}  ${StyleBold.render("Knowns")} ${StyleDim.render(`v${VERSION}`)}\n`,
    );
    ctx.print("\n");
    ctx.print(`  ${StyleInfo.render("→")}  ${StyleBold.render(url)}\n`);
    if (projectRoot !== "") {
      ctx.print(`  ${StyleInfo.render("⌁")}  ${StyleBold.render(projectRoot)}\n`);
    } else {
      ctx.print(
        `  ${StyleWarning.render("◇")}  ${StyleWarning.render("No project — workspace picker mode")}\n`,
      );
    }
    ctx.print("\n");
    if (passwordFlag !== "")
      ctx.print(`  ${StyleSuccess.render("🔒")}  Password protection active\n`);

    const served = server.serve(bound.bun);
    if (shouldOpen) {
      if (!(await waitForHTTPServer(port, 3000))) {
        await served;
        return;
      }
      openBrowser(url);
    }
    await served;
    void SilentExit;
  },
});
