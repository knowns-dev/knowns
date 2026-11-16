// The real runtime daemon (`__runtime run`) serving a session on its MCP endpoint, in a sandboxed
// HOME and runtime root: the descriptor appears, a proxy-style client gets an MCP session, the
// session holds a runtime lease while it lives, and a clean daemon stop removes the descriptor.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDescriptor } from "../../src/runtime/mcp-endpoint.ts";
import { VERSION } from "../../src/version.ts";
import { makeSandbox } from "../mcp/harness.ts";

const CLI_ROOT = join(import.meta.dir, "..", "..");
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

async function until<T>(f: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("runtime daemon hosting MCP sessions", () => {
  test("serves a session, holds a lease for it, and cleans up", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "kn-mcpd-")));
    const home = join(base, "home");
    const runtime = join(base, "runtime");
    mkdirSync(home);
    mkdirSync(runtime);
    const sb = makeSandbox("full");
    const daemon = Bun.spawn(
      [process.execPath, join(CLI_ROOT, "src", "main.ts"), "__runtime", "run"],
      {
        cwd: base,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          KNOWNS_RUNTIME_ROOT: runtime,
          KNOWNS_LSP_DAEMON: "0",
          // A client that opted out may be the one that started this daemon: the endpoint stays on.
          KNOWNS_MCP_PROXY: "0",
          KNOWN_LSP_AUTO_INSTALL: "0",
          NO_UPDATE_CHECK: "1",
          CI: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    procs.push(daemon);

    const d = await until(() => readDescriptor(VERSION, runtime));
    expect(d.pid).toBe(daemon.pid);

    const sock = net.connect({ path: d.address });
    const lines: string[] = [];
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    sock.on("error", () => undefined);
    const frame = async (match: (j: Record<string, unknown>) => boolean) => {
      const j = await until(() => {
        for (let i = 0; i < lines.length; i++) {
          const parsed = JSON.parse(lines[i] as string) as Record<string, unknown>;
          if (match(parsed)) {
            lines.splice(i, 1);
            return parsed;
          }
        }
        return undefined;
      });
      return j;
    };
    sock.write(
      `${JSON.stringify({
        knowns_mcp: 1,
        type: "hello",
        version: VERSION,
        token: d.token,
        cwd: sb.dir,
        project: "",
        pid: process.pid,
        client: { name: "test" },
      })}\n`,
    );
    expect(await frame((j) => j.type === "welcome")).toMatchObject({ daemon_pid: daemon.pid });
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } } })}\n`,
    );
    await frame((j) => j.id === 1);
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project", arguments: { action: "current" } } })}\n`,
    );
    const res = await frame((j) => j.id === 2);
    expect(JSON.stringify(res)).toContain(sb.dir.replaceAll("\\", "\\\\"));

    // The session holds a runtime lease for its project while it is open.
    const leaseDir = join(runtime, "leases");
    const leases = await until(() => {
      const l = existsSync(leaseDir)
        ? readdirSync(leaseDir).filter((n) => n.endsWith(".json"))
        : [];
      return l.length > 0 ? l : undefined;
    });
    expect(leases.length).toBeGreaterThanOrEqual(1);

    // Closing the connection releases it.
    sock.end();
    await until(() => {
      const l = existsSync(leaseDir)
        ? readdirSync(leaseDir).filter((n) => n.endsWith(".json"))
        : [];
      return l.length === 0 ? true : undefined;
    });

    // A clean stop removes the descriptor (the daemon exits on SIGTERM).
    daemon.kill("SIGTERM");
    await daemon.exited;
    expect(readDescriptor(VERSION, runtime)).toBeUndefined();
  }, 120_000);
});
