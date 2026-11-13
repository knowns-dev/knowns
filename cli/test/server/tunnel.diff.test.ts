// `knowns tunnel` and the /api/tunnel routes against a fake cloudflared (no network): the Go and TS
// servers must start, report and stop the same tunnel, and the CLI must print the same text.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GO_BIN,
  hasGoBin,
  mask,
  type Side,
  seedTemplate,
  send,
  startSide,
  stopSide,
  testEnv,
} from "./harness.ts";

// Starting two servers (and the Go init) is slow on Windows; hooks get the same budget as tests.
setDefaultTimeout(120_000);

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const J = { "Content-Type": "application/json" };
let go: Side;
let ts: Side;
let fakeDir: string;

beforeAll(async () => {
  if (!hasGoBin || process.platform === "win32") return;
  fakeDir = mkdtempSync(join(tmpdir(), "fake-cf-"));
  const script = join(fakeDir, "cloudflared");
  writeFileSync(
    script,
    '#!/bin/sh\necho "INF Requesting new quick Tunnel on trycloudflare.com..." >&2\necho "INF |  https://fake-tunnel-abc.trycloudflare.com  |" >&2\nexec sleep 300\n',
  );
  chmodSync(script, 0o755);
  const tpl = seedTemplate();
  const env = { PATH: `${fakeDir}:${process.env.PATH}` };
  // sequential: two concurrent freePort() calls can hand out the same port on Windows
  go = await startSide("go", tpl, { args: ["--password", "pw"], env });
  ts = await startSide("ts", tpl, { args: ["--password", "pw"], env });
});
afterAll(async () => {
  for (const s of [go, ts]) {
    if (!s) continue;
    await send(s, "POST", "/api/tunnel/stop", {
      headers: { Cookie: (s as Side & { cookie?: string }).cookie ?? "" },
    }).catch(() => undefined);
    stopSide(s);
  }
});

function cli(side: Side, args: string[]): string {
  const cmd = side.name === "go" ? [GO_BIN as string, ...args] : ["bun", MAIN, ...args];
  const r = Bun.spawnSync(cmd, {
    cwd: side.dir,
    env: testEnv(side.home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${r.exitCode}|${r.stdout.toString()}|${r.stderr.toString()}`;
}

describe.skipIf(!hasGoBin || process.platform === "win32")("tunnel parity", () => {
  test("routes and cli", async () => {
    const out: Record<string, string[]> = { go: [], ts: [] };
    for (const side of [go, ts]) {
      const log = out[side.name] as string[];
      const login = await fetch(`${side.base}/api/auth/login`, {
        method: "POST",
        headers: J,
        body: JSON.stringify({ password: "pw" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      (side as Side & { cookie?: string }).cookie = cookie;
      const h = { ...J, Cookie: cookie };
      const rec = async (m: string, p: string, body?: unknown) => {
        const r = await send(side, m, p, {
          headers: h,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        log.push(
          `${m} ${p} ${r.status} ${mask(r.text, side).replace(/"pid":\d+/g, '"pid":<PID>')}`,
        );
      };
      await rec("GET", "/api/tunnel/status");
      await rec("POST", "/api/tunnel/start");
      await rec("GET", "/api/tunnel/status");
      await rec("DELETE", "/api/auth/password");
      log.push(
        `status ${cli(side, ["tunnel", "status", "--port", String(side.port)]).replace(/pid=\d+/, "pid=<PID>")}`,
      );
      log.push(`status-other ${cli(side, ["tunnel", "status", "--port", "1"])}`);
      await rec("POST", "/api/tunnel/stop");
      log.push(
        `stop ${cli(side, ["tunnel", "stop", "--port", String(side.port)])}`.replace(
          String(side.port),
          "<PORT>",
        ),
      );
      await rec("GET", "/api/tunnel/status");
      log.push(
        `status-after ${cli(side, ["tunnel", "status", "--port", String(side.port)]).replace(String(side.port), "<PORT>")}`,
      );
    }
    expect((out.ts as string[]).join("\n").replaceAll(String(ts.port), "<PORT>")).toBe(
      (out.go as string[]).join("\n").replaceAll(String(go.port), "<PORT>"),
    );
  }, 90_000);
});
