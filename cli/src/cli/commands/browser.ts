// internal/cli/browser.go: `knowns browser`, the web UI server. The server module (and Bun.serve)
// load only when the command runs.
import { join, resolve } from "node:path";
import { bindBrowserPort, dial } from "../../server/listen.ts";
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

interface DaemonServeArgs {
  port: number;
  storeRoot: string;
  projectRoot: string;
  password: string;
  allowedOrigins: string[];
  dev: boolean;
  allowTaskHardDelete: boolean;
  shouldOpen: boolean;
}

/**
 * Asks the runtime daemon to serve the UI and waits here as the listener's lease. Returns "served"
 * when the user ended it, "fallback" when the daemon could not (or stopped) serving, in which case
 * the caller starts its own server as in 0.35.x.
 */
async function serveFromDaemon(
  ctx: CommandContext,
  a: DaemonServeArgs,
): Promise<{ served: true } | { served: false; port: number }> {
  const { requestDaemonListener } = await import("../../runtime/ui-client.ts");
  const outcome = await requestDaemonListener(
    {
      port: a.port,
      storeRoot: a.storeRoot,
      projectRoot: a.projectRoot,
      password: a.password,
      allowedOrigins: a.allowedOrigins,
      dev: a.dev,
      allowTaskHardDelete: a.allowTaskHardDelete,
    },
    { env: ctx.env },
  );
  if (!outcome.ok) {
    if (ctx.env.KNOWNS_DEBUG_PROXY === "1")
      ctx.printErr(`daemon UI unavailable: ${outcome.reason}\n`);
    return { served: false, port: a.port };
  }
  const { listener } = outcome;
  const url = `http://localhost:${listener.port}`;
  ctx.print("\n");
  ctx.print(
    `  ${StyleSuccess.render("●")}  ${StyleBold.render("Knowns")} ${StyleDim.render(`v${VERSION}`)}\n`,
  );
  ctx.print("\n");
  if (listener.port !== a.port) {
    ctx.print(
      `  ${StyleWarning.render("↷")}  Port ${a.port} is busy, using ${listener.port} instead\n`,
    );
  }
  ctx.print(`  ${StyleInfo.render("→")}  ${StyleBold.render(url)}\n`);
  ctx.print(`  ${StyleInfo.render("⌁")}  ${StyleBold.render(a.projectRoot)}\n\n`);
  if (a.password !== "") ctx.print(`  ${StyleSuccess.render("🔒")}  Password protection active\n`);
  if (a.shouldOpen) openBrowser(url);
  let userEnded = false;
  const onSignal = (): void => {
    userEnded = true;
    listener.release();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const end = await listener.closed;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  // The user ended it, or the server was stopped on purpose (POST /api/shutdown): done.
  if (userEnded || end === "released" || end === "stopped") return { served: true };
  // The daemon is exiting or died: the UI must not just vanish (D6, same rule as D2). Wait for the
  // port to free, then serve in this process on the SAME port.
  ctx.print(`  ${StyleWarning.render("↻")}  Runtime stopped; continuing with a local server\n`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await dial("127.0.0.1", listener.port, 200))) await sleep(100);
  return { served: false, port: listener.port };
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

    if (restart) {
      ctx.print(
        `${StyleWarning.render("↻")} Attempting to stop existing server on port ${port}...\n`,
      );
      await stopExistingServer(ctx, port);
    }

    // The daemon serves the UI when it can (spec D6). --tunnel keeps the in-process server: the
    // tunnel manager is tied to the process that owns the listener.
    // --dev logs verbosely to this terminal, so it stays in-process too.
    if (!tunnelFlag && !dev && store) {
      const outcome = await serveFromDaemon(ctx, {
        port,
        storeRoot: store.root,
        projectRoot,
        password: passwordFlag,
        allowedOrigins,
        dev,
        allowTaskHardDelete,
        shouldOpen,
      });
      if (outcome.served) return;
      port = outcome.port;
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
