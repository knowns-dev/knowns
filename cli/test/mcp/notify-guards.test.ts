// Approved divergence (D12, TSR-A3N6KY): the MCP process notifies a running web server through the
// port in .knowns/.server-port. 0.34.1 pasted that file and the doc path into the URL as they were,
// so a planted port ("<port>@other-host:<port>") sent the request to another host and a doc path
// with "?", "#" or ".." reached another route. The port must be a plain number, each path segment
// is percent-encoded, and dot segments are refused.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyDocUpdated, notifyTaskUpdated } from "../../src/mcp/notify.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

function server(): { port: number; seen: string[] } {
  const seen: string[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push(`${u.pathname}${u.search}${u.hash}`);
      return new Response("ok");
    },
  });
  servers.push(srv);
  return { port: srv.port as number, seen };
}

function root(portFile: string): { root: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowns-notify-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".server-port"), portFile);
  return { root: dir };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MCP server notifications", () => {
  test("a port file that is not a plain number sends nothing anywhere", async () => {
    const decoy = server();
    const other = server();
    // As a URL authority this is user "<decoy>" at host 127.0.0.1:<other>.
    notifyTaskUpdated(root(`${decoy.port}@127.0.0.1:${other.port}\n`), "KN-ABC123");
    await Bun.sleep(300);
    expect(other.seen).toEqual([]);
    expect(decoy.seen).toEqual([]);
  });

  test("doc path segments are percent-encoded", async () => {
    const srv = server();
    notifyDocUpdated(root(`${srv.port}\n`), "specs/a?b#c");
    await Bun.sleep(300);
    expect(srv.seen).toEqual(["/api/notify/doc/specs/a%3Fb%23c"]);
  });

  test("dot segments are refused", async () => {
    const srv = server();
    notifyDocUpdated(root(`${srv.port}\n`), "../../admin");
    await Bun.sleep(300);
    expect(srv.seen).toEqual([]);
  });

  test("a plain port still gets the request", async () => {
    const srv = server();
    notifyTaskUpdated(root(`${srv.port}\n`), "KN-ABC123");
    await Bun.sleep(300);
    expect(srv.seen).toEqual(["/api/notify/task/KN-ABC123"]);
  });
});
