// Approved divergence (D12, TSR-XSEKND): the LSP daemon gives a connected client a deadline to
// send its request (30 s; shortened here). 0.34.1 read with no deadline, so a client that
// connected and said nothing held a connection, and kept the daemon from its idle exit, forever.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../../src/lspdaemon/identity.ts";
import { Server } from "../../src/lspdaemon/server.ts";
import { listenEndpoint } from "../../src/lspdaemon/transport.ts";
import { StubManager } from "./support.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

test.skipIf(process.platform === "win32")(
  "a client that never sends its request is answered with a timeout and dropped",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "lspd-deadline-"));
    const paths = { socketPath: join(dir, "d.sock"), pipeName: "" } as unknown as Paths;
    const listener = await listenEndpoint(paths);
    const ac = new AbortController();
    const server = new Server({ root: dir, key: "k" }, paths, "token", new StubManager(), 0);
    server.requestReadTimeoutMs = 150;
    const served = server.serve(ac.signal, listener);
    cleanup.push(() => {
      ac.abort();
      rmSync(dir, { recursive: true, force: true });
    });

    const client = net.createConnection({ path: paths.socketPath });
    cleanup.push(() => client.destroy());
    let received = "";
    client.on("data", (d) => {
      received += d.toString("utf8");
    });
    const closed = new Promise<boolean>((r) => client.once("close", () => r(true)));
    const outcome = await Promise.race([closed, Bun.sleep(3000).then(() => false)]);
    expect(outcome).toBe(true);
    expect(received).toContain("i/o timeout");
    ac.abort();
    await served;
  },
);
