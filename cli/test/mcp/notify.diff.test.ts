// A running web server is told about changes through .knowns/.server-port and POST /api/notify/*.
// Both servers must send the same requests for the same calls.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin, McpSession, makeSandbox, type Side } from "./harness.ts";

async function run(side: Side): Promise<string[]> {
  const seen: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response("ok");
    },
  });
  const sb = makeSandbox("full");
  writeFileSync(join(sb.dir, ".knowns", ".server-port"), `${srv.port}\n`);
  const s = new McpSession(side, { cwd: sb.dir, home: sb.home });
  await s.initialize();
  await s.tool("tasks", { action: "update", taskId: "FX-19XJKQ", appendNotes: "x" });
  await s.tool("docs", { action: "update", path: "specs/login", appendContent: "x" });
  await s.tool("time", { action: "start", taskId: "FX-19XJKQ" });
  await s.tool("memory", { action: "update", id: "kunv9q", title: "t" });
  await Bun.sleep(500);
  await s.close();
  srv.stop(true);
  return seen.sort();
}

describe.skipIf(!hasGoBin)("server notifications match Go", () => {
  test("notify requests", async () => {
    const go = await run("go");
    const ts = await run("ts");
    expect(ts).toEqual(go);
    expect(go).toContain("POST /api/notify/task/FX-19XJKQ");
    expect(go).toContain("POST /api/notify/time");
    expect(go).toContain("POST /api/notify/refresh");
  }, 60_000);
});
