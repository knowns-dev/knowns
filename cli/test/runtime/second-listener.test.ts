// A second listener on an endpoint that is already served fails cleanly, and the process ends
// normally. On Windows, Bun 1.3.12 panics at exit (exit code 3, "Internal assertion failure") when a
// net.Server's listen() has failed on a named pipe that something else serves, so each endpoint
// asks the pipe first and never calls listen() on a live one. Each case runs in a child process:
// a panic cannot be seen from inside the process that dies of it.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dir, "..", "..", "src");
const href = (rel: string) => pathToFileURL(join(SRC, rel)).href;

const CASES: Record<string, { body: string; message: RegExp }> = {
  "the MCP endpoint": {
    message: /MCP endpoint already active/,
    body: `
      const { listenMcpEndpoint } = await import(${JSON.stringify(href("runtime/mcp-endpoint.ts"))});
      const root = process.env.CASE_DIR;
      const first = await listenMcpEndpoint(() => {}, { root, version: "9.9.9" });
      let message = "no error";
      try { await listenMcpEndpoint(() => {}, { root, version: "9.9.9" }); } catch (e) { message = e.message; }
      first.server.close();
      console.log(JSON.stringify({ message }));
    `,
  },
  "the UI host": {
    message: /UI endpoint already active/,
    body: `
      const { UiHost } = await import(${JSON.stringify(href("runtime/ui-host.ts"))});
      const root = process.env.CASE_DIR;
      const serve = async () => { throw new Error("unused"); };
      const a = new UiHost({ root, logger: () => undefined, serve });
      await a.start();
      const b = new UiHost({ root, logger: () => undefined, serve });
      let message = "no error";
      try { await b.start(); } catch (e) { message = e.message; }
      await a.stop();
      console.log(JSON.stringify({ message }));
    `,
  },
  "the LSP daemon": {
    message: /LSP daemon socket already active/,
    body: `
      const { listenEndpoint, cleanupEndpoint } = await import(${JSON.stringify(href("lspdaemon/transport.ts"))});
      const { identifyProject, pathsForIdentity } = await import(${JSON.stringify(href("lspdaemon/identity.ts"))});
      const { mkdirSync } = await import("node:fs");
      const paths = pathsForIdentity(identifyProject(process.env.CASE_DIR));
      mkdirSync(paths.dir ?? process.env.CASE_DIR, { recursive: true });
      const first = await listenEndpoint(paths);
      let message = "no error";
      try { await listenEndpoint(paths); } catch (e) { message = e.message; }
      first.close();
      cleanupEndpoint(paths);
      console.log(JSON.stringify({ message }));
    `,
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`a second listener on ${name} fails with "already active" and the process ends with exit code 0`, () => {
    const dir = mkdtempSync(join(tmpdir(), "knowns-second-listener-"));
    const file = join(dir, "child.mjs");
    writeFileSync(file, c.body);
    const spawn = () =>
      Bun.spawnSync([process.execPath, file], {
        env: { ...process.env, CASE_DIR: dir, KNOWNS_RUNTIME_INLINE: "1" },
        timeout: 30_000,
      });
    // Bun 1.3.12 on Windows sometimes returns a null exit code within milliseconds when the
    // suite is busy (seen once per full test/runtime run, never alone): the child never ran. A
    // panic is exit code 3, so retrying only a null code cannot hide it.
    let r = spawn();
    if (r.exitCode === null) r = spawn();
    const out = r.stdout.toString();
    expect({ code: r.exitCode, err: r.stderr.toString().slice(0, 400) }).toEqual({
      code: 0,
      err: "",
    });
    expect(JSON.parse(out.trim().split("\n").pop() ?? "{}").message).toMatch(c.message);
  }, 60_000);
}
