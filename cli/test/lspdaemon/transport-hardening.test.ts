// Transport hardening beyond Go (review of TSR-XSEKND): the unix socket is owner-only even though
// it lives in a shared temp dir, a frame larger than MAX_FRAME_BYTES is refused instead of growing
// without bound, and a client that never sends a request is dropped after the read timeout.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../../src/lspdaemon/identity.ts";
import { listenEndpoint, MAX_FRAME_BYTES, readJSON } from "../../src/lspdaemon/transport.ts";

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const unix = process.platform !== "win32";

function socketPaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "lspd-"));
  // Only the fields the unix endpoint reads; the rest are irrelevant to listen/dial.
  return { socketPath: join(dir, "d.sock"), pipeName: "" } as unknown as Paths;
}

test.skipIf(!unix)("the listening socket is owner-only (0600)", async () => {
  const paths = socketPaths();
  servers.push(await listenEndpoint(paths));
  expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
});

/** A connected socket pair over a fresh unix socket; `server` is the accepted side. */
async function pair(): Promise<{ client: net.Socket; server: net.Socket }> {
  const paths = socketPaths();
  const srv = await listenEndpoint(paths);
  servers.push(srv);
  const accepted = new Promise<net.Socket>((r) => srv.once("connection", r));
  const client = net.createConnection({ path: paths.socketPath });
  await new Promise<void>((r) => client.once("connect", () => r()));
  return { client, server: await accepted };
}

test.skipIf(!unix)("a frame past the cap is refused", async () => {
  const { client, server } = await pair();
  const reading = readJSON(server);
  client.write(`"${"x".repeat(MAX_FRAME_BYTES + 10)}`);
  await expect(reading).rejects.toThrow(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  client.destroy();
});

test.skipIf(!unix)("a silent client times out instead of holding the connection", async () => {
  const { client, server } = await pair();
  await expect(readJSON(server, { timeoutMs: 100 })).rejects.toThrow("i/o timeout");
  client.destroy();
});

test.skipIf(!unix)("a newline-terminated value still parses", async () => {
  const { client, server } = await pair();
  const reading = readJSON<{ a: number }>(server);
  client.write('{"a":');
  client.write("1}\n");
  expect(await reading).toEqual({ a: 1 });
  client.destroy();
});
