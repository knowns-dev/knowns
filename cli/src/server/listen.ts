// Port binding shared by `knowns browser` (its own server) and the runtime daemon's UI host.
import { createConnection } from "node:net";

export type FetchHandler = (
  req: Request,
  srv: { requestIP(req: Request): { address: string } | null },
) => Promise<Response>;

export function dial(host: string, port: number, timeoutMs: number): Promise<boolean> {
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

/** bindBrowserPort: skip ports something already answers on, then bind the first free one. */
export async function bindBrowserPort(
  startPort: number,
  attempts: number,
  fetchImpl: FetchHandler,
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
